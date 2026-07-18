'use strict';

/**
 * DecisionEngine — pure heuristic utilities shared by all strategy levels.
 *
 * All methods are static and side-effect-free.
 * They take game state as read-only input and return decisions.
 *
 * Architecture note: This layer is designed to be replaceable.
 * A future ML model can override specific methods (e.g. expectedValue)
 * without touching the game engine or strategy interface.
 */

const COLORS = ['Red', 'Green', 'Blue', 'Yellow'];

// --- Pick-Until 'discard-wilds' vs 'pick-color' decision tuning ---
const TOTAL_WILD_FAMILY_CARDS = 13; // 4 Wild + 4 Wild Draw Four + 4 Wild Pick Until + 1 Wild Swap
const LARGE_HAND_THRESHOLD = 7; // opponent avg hand size considered "large" (risk signal)
const SMALL_HAND_VULNERABLE_THRESHOLD = 4; // own hand size at/below which we have more to protect

class DecisionEngine {

    /**
     * Mirror of server.js isMoveValid — kept in sync manually.
     * Robo must only evaluate moves using its own visible information.
     */
    static isMoveValid(playedCard, topCard, activeColor, drawPenalty) {
        if (drawPenalty > 0) return playedCard.value === topCard.value;
        if (playedCard.color === 'Black') return true;
        return playedCard.color === activeColor || playedCard.value === topCard.value;
    }

    /**
     * Return all legal cards from a hand as { card, index } pairs.
     * @param {Array} hand
     * @param {{color:string, value:string}} topCard
     * @param {string} activeColor
     * @param {number} drawPenalty
     * @returns {Array<{card:object, index:number}>}
     */
    static getLegalCards(hand, topCard, activeColor, drawPenalty) {
        const legal = [];
        hand.forEach((card, index) => {
            if (DecisionEngine.isMoveValid(card, topCard, activeColor, drawPenalty)) {
                legal.push({ card, index });
            }
        });
        return legal;
    }

    /**
     * Count non-Black cards per color in a hand.
     * @param {Array} hand
     * @returns {{ Red:number, Green:number, Blue:number, Yellow:number }}
     */
    static countColorsInHand(hand) {
        const counts = { Red: 0, Green: 0, Blue: 0, Yellow: 0 };
        for (const card of hand) {
            if (card.color !== 'Black' && counts[card.color] !== undefined) {
                counts[card.color]++;
            }
        }
        return counts;
    }

    /**
     * Get the color the robo has most of — best choice for a Wild card.
     * Falls back to a random color if hand is all Black or empty.
     * @param {Array} hand
     * @returns {string}
     */
    static getBestWildColor(hand) {
        const counts = DecisionEngine.countColorsInHand(hand);
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        return sorted[0][1] > 0 ? sorted[0][0] : COLORS[Math.floor(Math.random() * COLORS.length)];
    }

    /**
     * Choose wild color that is best for robo AND hardest for opponents.
     * Weights: 70% own hand composition, 30% opponent disadvantage (from memory).
     * @param {Array} hand - Robo's hand
     * @param {string} selfName - Robo's name
     * @param {object} memory - CardMemory instance
     * @param {Array} players - All game players (for name reference only)
     * @returns {string}
     */
    static getBestWildColorAgainstOpponents(hand, selfName, memory, players) {
        const ownCounts = DecisionEngine.countColorsInHand(hand);

        // Aggregate colors played by opponents (from memory)
        const opponentFreq = { Red: 0, Green: 0, Blue: 0, Yellow: 0 };
        players.forEach(p => {
            if (p.name !== selfName && p.status === 'Active') {
                const freq = memory.getColorFrequencyForPlayer(p.name);
                COLORS.forEach(c => { opponentFreq[c] += freq[c]; });
            }
        });

        const maxOwn = Math.max(...Object.values(ownCounts), 1);
        const maxOpp = Math.max(...Object.values(opponentFreq), 1);

        const scores = {};
        COLORS.forEach(c => {
            const ownScore = (ownCounts[c] / maxOwn) * 0.7;
            // Low opponent frequency = bad for opponents = higher score
            const oppScore = (1 - (opponentFreq[c] / maxOpp)) * 0.3;
            scores[c] = ownScore + oppScore;
        });

        return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
    }

    /**
     * Pick a random legal card — used as timeout fallback.
     * @param {Array} hand
     * @param {{color:string,value:string}} topCard
     * @param {string} activeColor
     * @param {number} drawPenalty
     * @returns {{card:object, index:number}|null}
     */
    static getRandomLegalCard(hand, topCard, activeColor, drawPenalty) {
        const legal = DecisionEngine.getLegalCards(hand, topCard, activeColor, drawPenalty);
        if (legal.length === 0) return null;
        return legal[Math.floor(Math.random() * legal.length)];
    }

    /**
     * Find the opponent closest to winning (fewest cards, within threshold).
     * @param {Array} players
     * @param {number} selfIndex - Robo's own index (excluded)
     * @param {number} threshold - Max hand size to be considered threatening
     * @returns {{player:object, index:number}|null}
     */
    static findThreateningPlayer(players, selfIndex, threshold = 2) {
        let mostThreatening = null;
        let fewest = Infinity;
        players.forEach((p, i) => {
            if (i !== selfIndex && p.status === 'Active' && p.hand.length <= threshold && p.hand.length < fewest) {
                fewest = p.hand.length;
                mostThreatening = { player: p, index: i };
            }
        });
        return mostThreatening;
    }

    /**
     * Find the best card to block a threatening player.
     * Prefers: Skip → Draw Two → Wild Draw Four → Reverse
     * @param {Array<{card:object,index:number}>} legalCards
     * @param {number} threateningIndex
     * @param {number} currentIndex
     * @param {number} playDirection
     * @param {number} numPlayers
     * @returns {{card:object,index:number}|null}
     */
    static getBestBlockingCard(legalCards, threateningIndex, currentIndex, playDirection, numPlayers) {
        const nextIndex = (currentIndex + playDirection + numPlayers) % numPlayers;
        const isNextPlayer = nextIndex === threateningIndex;

        if (!isNextPlayer) {
            // Can't directly target — use Wild Draw Four if available
            return legalCards.find(c => c.card.value === 'Wild Draw Four') || null;
        }

        // Direct block: Skip > Draw Two > Wild Draw Four > Reverse
        for (const val of ['Skip', 'Draw Two', 'Wild Draw Four', 'Reverse']) {
            const found = legalCards.find(c => c.card.value === val);
            if (found) return found;
        }
        return null;
    }

    /**
     * Calculate expected value of playing a card (used by Expert strategy).
     * Higher score = more beneficial move.
     * @param {{color:string,value:string}} card
     * @param {object} gs - Game state
     * @param {number} playerIndex
     * @param {object} memory
     * @returns {number}
     */
    static expectedValue(card, gs, playerIndex, memory) {
        const player = gs.players[playerIndex];
        let ev = 10; // Base: playing any card is good (reduces hand)

        // Color match bonus — efficient play
        if (card.color === gs.activeColor) ev += 5;

        // Action card bonus — disruption value
        const actionBonus = {
            'Skip': 20, 'Reverse': 15, 'Draw Two': 25,
            'Wild': 30, 'Wild Draw Four': 50, 'Wild Pick Until': 40, 'Wild Swap': 35
        };
        ev += (actionBonus[card.value] || parseInt(card.value) || 0) * 0.3;

        // Smaller hand = higher urgency to play
        const newSize = player.hand.length - 1;
        ev += (10 - Math.min(newSize, 10)) * 2;

        // Going to UNO
        if (newSize === 1) ev += 20;

        // Going out
        if (newSize === 0) ev += 100;

        // Blocking bonus when an opponent is close to winning
        const threat = DecisionEngine.findThreateningPlayer(gs.players, playerIndex, 2);
        if (threat) {
            if (['Skip', 'Draw Two', 'Wild Draw Four', 'Reverse'].includes(card.value)) ev += 25;
        }

        // Penalty for wasting a Wild when no urgent need
        if (card.color === 'Black' && !threat && player.hand.length > 3) ev -= 15;

        return ev;
    }

    /**
     * EXPERT: Decide whether a Wild Pick Until card is better used to strip
     * every opponent's Wild-family cards ('discard-wilds') rather than the
     * default single-target draw-until-color attack ('pick-color').
     *
     * Uses ONLY publicly visible information: opponents' hand sizes, the
     * robo's own hand, the draw pile size, and cards already seen this
     * round via memory. Never reads another player's actual hand contents.
     *
     * Weighs three public signals:
     *  1. Estimated Wild-family cards likely sitting in opponents' hands
     *     (deck total minus wilds played minus our own wilds, scaled by
     *     the public ratio of opponent-cards vs draw-pile-cards).
     *  2. Average opponent hand size ("large hands" risk signal).
     *  3. Our own vulnerability (smaller hand = more to protect from a
     *     future Wild Draw Four / Wild Swap landing on us).
     *
     * @param {object} gs - Game state
     * @param {number} playerIndex - Robo's index in gs.players
     * @param {object} memory - CardMemory instance
     * @returns {boolean} true → choose 'discard-wilds', false → choose 'pick-color'
     */
    static shouldDiscardOpponentWilds(gs, playerIndex, memory) {
        const player = gs.players[playerIndex];
        const opponents = gs.players.filter((p, i) => i !== playerIndex && p.status === 'Active');
        if (opponents.length === 0) return false;

        // Don't override an immediate direct-attack opportunity on the next player.
        const threat = DecisionEngine.findThreateningPlayer(gs.players, playerIndex, 2);
        if (threat) return false;

        // Estimate unseen Wild-family cards (not yet played, not in our own hand).
        const ownWilds = player.hand.filter(c => c.color === 'Black').length;
        const wildsPlayed = memory.getWildsPlayedCount();
        const unseenWilds = Math.max(0, TOTAL_WILD_FAMILY_CARDS - wildsPlayed - ownWilds);
        if (unseenWilds === 0) return false; // nothing left to strip from opponents

        // Probability-weighted share of those unseen wilds likely in opponents'
        // hands vs. the draw pile, using only public card counts.
        const totalOpponentCards = opponents.reduce((sum, p) => sum + p.hand.length, 0);
        const drawPileSize = gs.drawPile.length;
        const denominator = totalOpponentCards + drawPileSize;
        const opponentShare = denominator > 0 ? totalOpponentCards / denominator : 0;
        const estimatedOpponentWilds = unseenWilds * opponentShare;

        // "Large hands" signal.
        const avgOpponentHandSize = totalOpponentCards / opponents.length;

        // Our own vulnerability — smaller hand means more to lose to a future
        // Wild Draw Four / Wild Swap, so the defensive payoff is worth more.
        const ownVulnerability = player.hand.length <= SMALL_HAND_VULNERABLE_THRESHOLD ? 1 : 0.5;

        const score =
            (estimatedOpponentWilds / TOTAL_WILD_FAMILY_CARDS) * 0.5 +
            (Math.min(avgOpponentHandSize / LARGE_HAND_THRESHOLD, 1)) * 0.3 +
            ownVulnerability * 0.2;

        return score >= 0.55; // tuned to fire only when evidence is genuinely strong
    }

    /**
     * HARD: Simpler, rule-of-thumb version of shouldDiscardOpponentWilds —
     * direct threshold checks on public hand sizes only, no probability
     * weighting of unseen wilds. Consistent with how Hard makes its other
     * decisions elsewhere (direct comparisons, not weighted scoring).
     *
     * @param {object} gs
     * @param {number} playerIndex
     * @returns {boolean} true → choose 'discard-wilds', false → choose 'pick-color'
     */
    static shouldDiscardOpponentWildsSimple(gs, playerIndex) {
        const player = gs.players[playerIndex];
        const opponents = gs.players.filter((p, i) => i !== playerIndex && p.status === 'Active');
        if (opponents.length === 0) return false;

        // Don't override an immediate direct-attack opportunity on the next player.
        const threat = DecisionEngine.findThreateningPlayer(gs.players, playerIndex, 2);
        if (threat) return false;

        const avgOpponentHandSize = opponents.reduce((sum, p) => sum + p.hand.length, 0) / opponents.length;
        const ownHandSmall = player.hand.length <= SMALL_HAND_VULNERABLE_THRESHOLD;

        // Fire only in the clear-cut case: we have relatively little hand-size
        // to protect, and opponents are visibly loaded up with cards.
        return ownHandSmall && avgOpponentHandSize >= LARGE_HAND_THRESHOLD;
    }
}

module.exports = { DecisionEngine, COLORS };
