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
}

module.exports = { DecisionEngine, COLORS };
