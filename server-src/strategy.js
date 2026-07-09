'use strict';

/**
 * Strategy — async interface for robo move selection.
 *
 * All strategies implement one method: selectMove(gs, playerIndex, memory)
 * The async signature future-proofs the interface for:
 *   - Remote ML model inference (HTTP/WebSocket calls)
 *   - Local WASM neural network execution
 *   - Reinforcement learning agents
 *   - Custom strategy plugins
 *
 * Move return types:
 *   { type:'playCard',       cardIndex:number }
 *   { type:'drawCard' }
 *   { type:'chooseColor',    color:string }
 *   { type:'pickUntilChoice',choice:'pick-color'|'discard-wilds' }
 *   { type:'swapHandsChoice',targetPlayerId:string }
 */

const { DecisionEngine, COLORS } = require('./decision-engine');

// ─────────────────────────────────────────────────────────────────────────────
// BASE CLASS
// ─────────────────────────────────────────────────────────────────────────────

class Strategy {
    /**
     * @param {object} gs - Current game state (treat as read-only)
     * @param {number} playerIndex - Robo's index in gs.players
     * @param {object} memory - CardMemory instance
     * @returns {Promise<object>} Move object
     */
    async selectMove(gs, playerIndex, memory) {
        throw new Error(`${this.constructor.name}.selectMove() not implemented`);
    }

    /**
     * Returns true ONLY when the player absolutely must draw (no valid play exists).
     * Note: drawPenalty does NOT force a draw — the player may still stack with a
     * same-value card (e.g. Draw Two on Draw Two). getLegalCards handles this via
     * isMoveValid: when drawPenalty > 0, only same-value cards are legal.
     */
    _mustDraw(gs, playerIndex) {
        // Pick-Until: player must keep drawing cards
        if (gs.pickUntilState?.active && gs.pickUntilState.targetPlayerIndex === playerIndex) return true;
        return false;
    }

    /** Shared: pick a random active opponent for swap. */
    _randomOpponent(gs, playerIndex) {
        const others = gs.players.filter((p, i) => i !== playerIndex && p.status === 'Active');
        return others.length > 0 ? others[Math.floor(Math.random() * others.length)] : null;
    }

    /** Shared: pick the opponent with fewest cards for swap. */
    _weakestOpponent(gs, playerIndex) {
        return gs.players
            .map((p, i) => ({ player: p, index: i }))
            .filter(({ player: p, index: i }) => i !== playerIndex && p.status === 'Active')
            .sort((a, b) => a.player.hand.length - b.player.hand.length)[0]?.player || null;
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// EASY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Easy Strategy
 * - Plays the first legal card in hand (no ranking)
 * - Draws immediately when no legal card
 * - Picks random Wild colour
 * - No tactical use of action cards
 * - Memory: last 3 cards (unused for decisions)
 */
class EasyStrategy extends Strategy {
    async selectMove(gs, playerIndex, memory) {
        const player = gs.players[playerIndex];

        // ── Phase: ChoosingColor ───────────────────────────────────────────
        if (gs.phase === 'ChoosingColor') {
            return { type: 'chooseColor', color: COLORS[Math.floor(Math.random() * COLORS.length)] };
        }

        // ── Phase: ChoosingPickUntilAction ────────────────────────────────
        if (gs.phase === 'ChoosingPickUntilAction') {
            return { type: 'pickUntilChoice', choice: 'pick-color' };
        }

        // ── Phase: ChoosingSwapHands ──────────────────────────────────────
        if (gs.phase === 'ChoosingSwapHands') {
            const target = this._randomOpponent(gs, playerIndex);
            return { type: 'swapHandsChoice', targetPlayerId: target?.playerId || player.playerId };
        }

        // ── Phase: Playing ────────────────────────────────────────────────
        // Easy always draws when penalised (no stacking — keeps difficulty easy)
        if (gs.drawPenalty > 0) return { type: 'drawCard' };
        if (this._mustDraw(gs, playerIndex)) return { type: 'drawCard' };

        const topCard = gs.discardPile[0].card;
        const legal = DecisionEngine.getLegalCards(player.hand, topCard, gs.activeColor, gs.drawPenalty);

        if (legal.length === 0) return { type: 'drawCard' };

        // Easy: first legal card, no strategy
        return { type: 'playCard', cardIndex: legal[0].index };
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// NORMAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normal Strategy
 * - Prefers colour matches over value matches
 * - Retains Wild cards (only uses them when necessary or hand is large)
 * - Uses Draw Two against players with few cards
 * - Picks Wild colour based on own hand composition
 * - Memory: last 10 cards
 */
class NormalStrategy extends Strategy {
    async selectMove(gs, playerIndex, memory) {
        const player = gs.players[playerIndex];

        if (gs.phase === 'ChoosingColor') {
            return { type: 'chooseColor', color: DecisionEngine.getBestWildColor(player.hand) };
        }

        if (gs.phase === 'ChoosingPickUntilAction') {
            return { type: 'pickUntilChoice', choice: 'pick-color' };
        }

        if (gs.phase === 'ChoosingSwapHands') {
            const target = this._weakestOpponent(gs, playerIndex);
            return { type: 'swapHandsChoice', targetPlayerId: target?.playerId || player.playerId };
        }

        if (this._mustDraw(gs, playerIndex)) return { type: 'drawCard' };

        const topCard = gs.discardPile[0].card;
        const legal = DecisionEngine.getLegalCards(player.hand, topCard, gs.activeColor, gs.drawPenalty);
        if (legal.length === 0) return { type: 'drawCard' };

        const nonWilds = legal.filter(c => c.card.color !== 'Black');
        const wilds    = legal.filter(c => c.card.color === 'Black');

        const colorMatch = nonWilds.filter(c => c.card.color === gs.activeColor);
        const valueMatch = nonWilds.filter(c => c.card.color !== gs.activeColor);

        const threat = DecisionEngine.findThreateningPlayer(gs.players, playerIndex, 2);

        // Tactical: use Draw Two against a player nearing win
        if (threat) {
            const drawTwo = colorMatch.find(c => c.card.value === 'Draw Two');
            if (drawTwo) return { type: 'playCard', cardIndex: drawTwo.index };
        }

        // Prefer colour match — play number cards first to save action cards
        if (colorMatch.length > 0) {
            const number = colorMatch.find(c => !['Skip','Reverse','Draw Two'].includes(c.card.value));
            if (number) return { type: 'playCard', cardIndex: number.index };
            // Play action card if no number match
            return { type: 'playCard', cardIndex: colorMatch[0].index };
        }

        // Value match (different colour)
        if (valueMatch.length > 0) {
            return { type: 'playCard', cardIndex: valueMatch[0].index };
        }

        // Use Wild only when hand is big (≥ 4 cards) or no other option
        if (wilds.length > 0) {
            if (player.hand.length >= 4 || nonWilds.length === 0) {
                const regularWild = wilds.find(c => c.card.value === 'Wild');
                return { type: 'playCard', cardIndex: (regularWild || wilds[0]).index };
            }
        }

        return { type: 'drawCard' };
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// HARD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hard Strategy
 * - Tracks ALL cards played (full memory)
 * - Estimates opponent colour preferences from history
 * - Blocks opponents who are close to winning
 * - Chooses Wild colour strategically (best for self + worst for opponents)
 * - Preserves Wild Draw Four for high-value blocking moments
 * - Memory: unlimited
 */
class HardStrategy extends Strategy {
    async selectMove(gs, playerIndex, memory) {
        const player = gs.players[playerIndex];

        if (gs.phase === 'ChoosingColor') {
            return {
                type: 'chooseColor',
                color: DecisionEngine.getBestWildColorAgainstOpponents(player.hand, player.name, memory, gs.players)
            };
        }

        if (gs.phase === 'ChoosingPickUntilAction') {
            return { type: 'pickUntilChoice', choice: 'pick-color' };
        }

        if (gs.phase === 'ChoosingSwapHands') {
            const target = this._weakestOpponent(gs, playerIndex);
            return { type: 'swapHandsChoice', targetPlayerId: target?.playerId || player.playerId };
        }

        if (this._mustDraw(gs, playerIndex)) return { type: 'drawCard' };

        const topCard = gs.discardPile[0].card;
        const legal = DecisionEngine.getLegalCards(player.hand, topCard, gs.activeColor, gs.drawPenalty);
        if (legal.length === 0) return { type: 'drawCard' };

        const threat = DecisionEngine.findThreateningPlayer(gs.players, playerIndex, 2);

        // Blocking has highest priority
        if (threat) {
            const block = DecisionEngine.getBestBlockingCard(
                legal, threat.index, playerIndex, gs.playDirection, gs.players.length
            );
            if (block) return { type: 'playCard', cardIndex: block.index };
        }

        const nonWilds = legal.filter(c => c.card.color !== 'Black');
        const wilds    = legal.filter(c => c.card.color === 'Black');

        const colorMatch = nonWilds.filter(c => c.card.color === gs.activeColor);
        const valueMatch = nonWilds.filter(c => c.card.color !== gs.activeColor);

        const someoneClose = gs.players.some((p, i) => i !== playerIndex && p.status === 'Active' && p.hand.length <= 3);

        if (colorMatch.length > 0) {
            // Play action card if someone is getting close, otherwise save it
            if (someoneClose) {
                const action = colorMatch.find(c => ['Skip','Reverse','Draw Two'].includes(c.card.value));
                if (action) return { type: 'playCard', cardIndex: action.index };
            }
            // Play number card to preserve action cards
            const number = colorMatch.find(c => !['Skip','Reverse','Draw Two'].includes(c.card.value));
            return { type: 'playCard', cardIndex: (number || colorMatch[0]).index };
        }

        if (valueMatch.length > 0) {
            // Choose value match with colour closest to our best colour
            const ourBest = DecisionEngine.getBestWildColorAgainstOpponents(player.hand, player.name, memory, gs.players);
            const best = valueMatch.find(c => c.card.color === ourBest) || valueMatch[0];
            return { type: 'playCard', cardIndex: best.index };
        }

        if (wilds.length > 0) {
            // Use Wild Draw Four only for blocking; regular Wild freely
            if (threat) {
                const drawFour = wilds.find(c => c.card.value === 'Wild Draw Four');
                if (drawFour) return { type: 'playCard', cardIndex: drawFour.index };
            }
            const regularWild = wilds.find(c => c.card.value === 'Wild');
            return { type: 'playCard', cardIndex: (regularWild || wilds[0]).index };
        }

        return { type: 'drawCard' };
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// EXPERT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expert Strategy
 * - All of Hard, plus Expected Value scoring for every legal card
 * - End-game optimisation: when at 1-2 cards, plays aggressively
 * - Emergency block override: prioritises blocking over EV when opponent has 1 card
 * - Designed as a drop-in replacement target for future ML/RL models
 * - Memory: unlimited
 */
class ExpertStrategy extends Strategy {
    async selectMove(gs, playerIndex, memory) {
        const player = gs.players[playerIndex];

        if (gs.phase === 'ChoosingColor') {
            return {
                type: 'chooseColor',
                color: DecisionEngine.getBestWildColorAgainstOpponents(player.hand, player.name, memory, gs.players)
            };
        }

        if (gs.phase === 'ChoosingPickUntilAction') {
            return { type: 'pickUntilChoice', choice: 'pick-color' };
        }

        if (gs.phase === 'ChoosingSwapHands') {
            const target = this._weakestOpponent(gs, playerIndex);
            return { type: 'swapHandsChoice', targetPlayerId: target?.playerId || player.playerId };
        }

        if (this._mustDraw(gs, playerIndex)) return { type: 'drawCard' };

        const topCard = gs.discardPile[0].card;
        const legal = DecisionEngine.getLegalCards(player.hand, topCard, gs.activeColor, gs.drawPenalty);
        if (legal.length === 0) return { type: 'drawCard' };

        // End-game: 1-2 cards → play aggressively
        if (player.hand.length <= 2) {
            const nonWild = legal.find(c => c.card.color !== 'Black');
            return { type: 'playCard', cardIndex: (nonWild || legal[0]).index };
        }

        // Emergency block: opponent has 1 card → override EV
        const immediateThreat = DecisionEngine.findThreateningPlayer(gs.players, playerIndex, 1);
        if (immediateThreat) {
            const block = DecisionEngine.getBestBlockingCard(
                legal, immediateThreat.index, playerIndex, gs.playDirection, gs.players.length
            );
            if (block) return { type: 'playCard', cardIndex: block.index };
        }

        // Rank all legal cards by Expected Value
        const ranked = legal
            .map(lc => ({ ...lc, ev: DecisionEngine.expectedValue(lc.card, gs, playerIndex, memory) }))
            .sort((a, b) => b.ev - a.ev);

        return { type: 'playCard', cardIndex: ranked[0].index };
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────

class StrategyFactory {
    /**
     * Instantiate the correct Strategy for a given difficulty level.
     * @param {string} difficulty - 'Easy'|'Normal'|'Hard'|'Expert'
     * @returns {Strategy}
     */
    static create(difficulty) {
        switch (difficulty) {
            case 'Easy':   return new EasyStrategy();
            case 'Normal': return new NormalStrategy();
            case 'Hard':   return new HardStrategy();
            case 'Expert': return new ExpertStrategy();
            default:
                console.warn(`[Robo] Unknown difficulty '${difficulty}', defaulting to Normal`);
                return new NormalStrategy();
        }
    }

    /**
     * Instantiate a CardMemory sized for the given difficulty.
     * @param {string} difficulty
     * @returns {CardMemory}
     */
    static createMemory(difficulty) {
        const { CardMemory } = require('./card-memory');
        switch (difficulty) {
            case 'Easy':   return new CardMemory(3);
            case 'Normal': return new CardMemory(10);
            case 'Hard':   return new CardMemory(Infinity);
            case 'Expert': return new CardMemory(Infinity);
            default:       return new CardMemory(10);
        }
    }
}

module.exports = { Strategy, EasyStrategy, NormalStrategy, HardStrategy, ExpertStrategy, StrategyFactory };
