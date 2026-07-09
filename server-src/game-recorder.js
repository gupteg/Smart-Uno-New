'use strict';

/**
 * GameRecorder — records every player decision to MongoDB Atlas for ML training.
 *
 * Controlled by RECORD_GAMES=true environment variable.
 * One MongoDB document per round. Moves buffered in memory, flushed on round end.
 * Completely non-blocking — DB writes never delay game flow.
 *
 * Enhanced state snapshot captures:
 *   - Own hand + wild card count
 *   - Top card, active colour, draw penalty, pick-until state
 *   - Recent discard pile history (last 20 cards)
 *   - Colour depletion counts (how many of each colour played this round)
 *   - Wild card circulation estimate
 *   - Per-opponent: card count, score, score gap, turn proximity,
 *                   inferred missing colours (from observed draws),
 *                   high-hand flag (likely holds action cards)
 *   - My score and score rank among active players
 *
 * MongoDB structure:
 *   Database:   uno_game
 *   Collection: rounds
 */

const { MongoClient } = require('mongodb');

class GameRecorder {

    constructor() {
        this.enabled       = process.env.RECORD_GAMES === 'true';
        this.client        = null;
        this.collection    = null;
        this.currentGameId = null;
        this.currentRound  = null;
        // currentRound shape:
        // { roundNumber, numCardsToDeal, playerNames, moves[],
        //   colorInferences: { playerName: Set<color> } }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    async connect() {
        if (!this.enabled) {
            console.log('[Recorder] RECORD_GAMES not set — recording disabled.');
            return;
        }
        const uri = process.env.MONGODB_URI;
        if (!uri) {
            console.warn('[Recorder] RECORD_GAMES=true but MONGODB_URI missing — recording disabled.');
            this.enabled = false;
            return;
        }
        try {
            this.client     = new MongoClient(uri);
            await this.client.connect();
            const db        = this.client.db('uno_game');
            this.collection = db.collection('rounds');

            await this.collection.createIndex({ gameId: 1 });
            await this.collection.createIndex({ recordedAt: -1 });
            await this.collection.createIndex({ 'moves.playerName': 1 });
            await this.collection.createIndex({ 'moves.isRobo': 1 });

            console.log('[Recorder] ✅ Connected to MongoDB Atlas — game recording active.');
        } catch (err) {
            console.error('[Recorder] ❌ Failed to connect:', err.message);
            this.enabled = false;
        }
    }

    async disconnect() {
        if (this.client) {
            await this.client.close();
            console.log('[Recorder] Disconnected.');
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Game / Round lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Called once when a new game begins (after setupGame).
     * Generates a unique gameId that spans all rounds.
     */
    startGame(players) {
        if (!this.enabled) return;
        this.currentGameId = Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
        console.log(`[Recorder] New game: ${this.currentGameId} (${players.length} players)`);
    }

    /**
     * Called at the start of each round, after cards are dealt.
     * Resets the colour inference table for the new round.
     */
    startRound(roundNumber, numCardsToDeal, players) {
        if (!this.enabled) return;
        this.currentRound = {
            roundNumber,
            numCardsToDeal,
            playerNames:      players.map(p => p.name),
            moves:            [],
            colorInferences:  {}   // { playerName: Set<colorString> }
        };
    }

    /**
     * Record one player decision.
     * Always call BEFORE modifying game state so the snapshot reflects
     * exactly what the player saw at the moment of their decision.
     *
     * Also updates colour inference table: whenever a player draws,
     * the active colour (or pick-until target colour) is marked as
     * likely absent from their hand.
     *
     * @param {object} playerInfo   - { name, isRobo, difficulty, position }
     * @param {object} visibleState - output of this.buildVisibleState()
     * @param {object} action       - { type, ...fields }
     */
    recordMove(playerInfo, visibleState, action) {
        if (!this.enabled || !this.currentRound) return;

        // ── Update colour inference on draw events ────────────────────────────
        const drawTypes = ['drawCard', 'acceptPenalty', 'drawPickUntil'];
        if (drawTypes.includes(action.type) && visibleState) {
            if (!this.currentRound.colorInferences[playerInfo.name]) {
                this.currentRound.colorInferences[playerInfo.name] = new Set();
            }
            // For pick-until: infer from the target colour, not the global active colour
            const missingColor = action.type === 'drawPickUntil'
                ? visibleState.pickUntilTargetColor
                : visibleState.activeColor;
            if (missingColor && missingColor !== 'Black') {
                this.currentRound.colorInferences[playerInfo.name].add(missingColor);
            }
        }

        this.currentRound.moves.push({
            moveIndex:      this.currentRound.moves.length,
            playerName:     playerInfo.name,
            isRobo:         playerInfo.isRobo    || false,
            difficulty:     playerInfo.difficulty || null,
            playerPosition: playerInfo.position,
            state:          visibleState,
            action,
            timestamp:      new Date()
        });
    }

    /**
     * Called when a round ends.
     * Writes the complete round document to Atlas (non-blocking).
     * @param {string[]} winnerNames
     */
    async endRound(winnerNames) {
        if (!this.enabled || !this.currentRound || !this.collection) return;

        const document = {
            gameId:         this.currentGameId,
            roundNumber:    this.currentRound.roundNumber,
            numCardsToDeal: this.currentRound.numCardsToDeal,
            numPlayers:     this.currentRound.playerNames.length,
            playerNames:    this.currentRound.playerNames,
            winners:        winnerNames,
            totalMoves:     this.currentRound.moves.length,
            moves:          this.currentRound.moves,
            recordedAt:     new Date()
        };

        const roundNum  = this.currentRound.roundNumber;
        const moveCount = this.currentRound.moves.length;
        this.currentRound = null; // clear immediately — next round can start

        try {
            await this.collection.insertOne(document);
            console.log(
                `[Recorder] Round ${roundNum} saved — ` +
                `${moveCount} moves, winner(s): ${winnerNames.join(', ')}`
            );
        } catch (err) {
            console.error('[Recorder] Failed to save round:', err.message);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // State snapshot (instance method — needs access to colorInferences)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Extract everything a player can legally observe at decision time.
     * Does NOT include other players' actual cards (no cheating).
     * Enriched with inferred intelligence derived from observed game events.
     *
     * @param {object} gs          - full gameState (treated as read-only)
     * @param {number} playerIndex - the player making this decision
     * @returns {object}           - serialisable state snapshot
     */
    buildVisibleState(gs, playerIndex) {
        const player = gs.players[playerIndex];
        if (!player) return null;

        const numPlayers     = gs.players.length;
        const activePlayers  = gs.players.filter(p => p.status === 'Active');

        // ── Colour depletion + wild circulation from discard history ──────────
        const colorDepletion = { Red: 0, Green: 0, Blue: 0, Yellow: 0 };
        let wildCardsPlayed  = 0;
        gs.discardPile.forEach(d => {
            if (!d.card) return;
            if (d.card.color === 'Black') { wildCardsPlayed++; }
            else if (colorDepletion[d.card.color] !== undefined) { colorDepletion[d.card.color]++; }
        });

        // ── My own wild count ─────────────────────────────────────────────────
        const myWildCount = player.hand.filter(c => c.color === 'Black').length;

        // ── Score context ─────────────────────────────────────────────────────
        const activeScores = activePlayers.map(p => p.score);
        const maxScore     = activeScores.length ? Math.max(...activeScores) : 0;

        // My score rank (1 = lowest score = currently winning in UNO)
        const sortedByScore = [...activePlayers].sort((a, b) => a.score - b.score);
        const myScoreRank   = sortedByScore.findIndex(p => p.playerId === player.playerId) + 1;

        // ── Opponents enriched with score, proximity, inferences ──────────────
        const opponents = gs.players
            .filter((_, i) => i !== playerIndex)
            .map(p => {
                const pos = gs.players.indexOf(p);

                // Seats away in current play direction (1 = immediately next)
                let seatsAway = 0;
                let check     = playerIndex;
                for (let s = 0; s < numPlayers; s++) {
                    check = (check + gs.playDirection + numPlayers) % numPlayers;
                    seatsAway++;
                    if (check === pos) break;
                }

                // Inferred missing colours from observed draws this round
                const inferredSet     = this.currentRound?.colorInferences[p.name];
                const inferredMissing = inferredSet ? [...inferredSet] : [];

                return {
                    name:      p.name,
                    isRobo:    p.isRobo || false,
                    cardCount: p.hand.length,
                    unoState:  p.unoState,
                    status:    p.status,
                    position:  pos,

                    // Turn proximity
                    seatsAway,
                    isNextToAct:     seatsAway === 1,   // immediately after me
                    isJustBeforeMe:  seatsAway === numPlayers - 1, // plays just before me

                    // Score context — enables score-rival targeting
                    score:          p.score,
                    scoreGap:       p.score - player.score, // +ve = they are ahead (danger)
                    isScoreLeader:  p.score === maxScore && maxScore > 0,

                    // Inferred colour absences (from observed draws this round)
                    inferredMissingColors: inferredMissing,
                    hasInferredData:       inferredMissing.length > 0,

                    // Large hand flag — likely holding action cards / wilds
                    // (especially relevant for Wild Swap / Pick Until decisions)
                    highCardCountFlag: p.hand.length >= 6,
                };
            });

        // ── Recent discard history (last 20 plays) ────────────────────────────
        const recentDiscardHistory = gs.discardPile.slice(0, 20).map(d => ({
            color:    d.card?.color    || null,
            value:    d.card?.value    || null,
            playedBy: d.playerName     || null
        }));

        return {
            // ── Own hand ──────────────────────────────────────────────────────
            hand:         player.hand.map(c => ({ color: c.color, value: c.value })),
            handSize:     player.hand.length,
            myWildCount,

            // ── Discard pile ──────────────────────────────────────────────────
            topCard: gs.discardPile[0]?.card
                ? { color: gs.discardPile[0].card.color, value: gs.discardPile[0].card.value }
                : null,
            activeColor:           gs.activeColor,
            recentDiscardHistory,

            // ── Colour intelligence ───────────────────────────────────────────
            colorDepletionThisRound: colorDepletion,  // how many of each colour played
            wildCardsPlayedThisRound: wildCardsPlayed, // wilds in discard — fewer in draw pile

            // ── Penalty / special states ──────────────────────────────────────
            drawPenalty:          gs.drawPenalty,
            pickUntilActive:      gs.pickUntilState?.active         || false,
            pickUntilTargetColor: gs.pickUntilState?.targetColor    || null,
            isPickUntilTarget:    !!(gs.pickUntilState?.active &&
                                     gs.pickUntilState.targetPlayerIndex === playerIndex),

            // ── Turn context ──────────────────────────────────────────────────
            playDirection:    gs.playDirection,
            phase:            gs.phase,
            playerIndex,
            numActivePlayers: activePlayers.length,

            // ── My score context ──────────────────────────────────────────────
            myScore:      player.score,
            myScoreRank,               // 1 = currently winning (lowest score)
            isLeading:    myScoreRank === 1 && activePlayers.length > 1,

            // ── Opponents (enriched) ──────────────────────────────────────────
            opponents,

            // ── Pile sizes ────────────────────────────────────────────────────
            drawPileSize:    gs.drawPile.length,
            discardPileSize: gs.discardPile.length,

            // ── Round context ─────────────────────────────────────────────────
            roundNumber:    gs.roundNumber,
            numCardsToDeal: gs.numCardsToDeal
        };
    }
}

module.exports = { GameRecorder };
