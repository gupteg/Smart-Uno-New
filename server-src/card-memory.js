'use strict';

/**
 * CardMemory — tracks cards played to the discard pile during a round.
 *
 * Memory depth is configurable per difficulty level:
 *   Easy   → 3 cards  (barely any tracking)
 *   Normal → 10 cards (recent history only)
 *   Hard   → Infinity (full round history)
 *   Expert → Infinity (full round history)
 *
 * Designed so that the game engine never reads from memory directly.
 * Only strategies consume this data.
 */
class CardMemory {
    /**
     * @param {number} maxCards - Maximum entries to keep. Use Infinity for unlimited.
     */
    constructor(maxCards = 10) {
        this.maxCards = maxCards;
        /** @type {Array<{color:string, value:string, playedBy:string}>} */
        this.playedCards = [];
    }

    /**
     * Record one card that was just played to the discard pile.
     * Called by the game engine after every successful card play.
     * @param {{color:string, value:string}} card
     * @param {string} playerName
     */
    recordCard(card, playerName) {
        if (this.maxCards === 0) return;
        this.playedCards.unshift({ color: card.color, value: card.value, playedBy: playerName });
        if (this.playedCards.length > this.maxCards) {
            this.playedCards.pop();
        }
    }

    /**
     * Count how often each color was played by a specific player.
     * @param {string} playerName
     * @returns {{ Red:number, Green:number, Blue:number, Yellow:number }}
     */
    getColorFrequencyForPlayer(playerName) {
        const freq = { Red: 0, Green: 0, Blue: 0, Yellow: 0 };
        for (const entry of this.playedCards) {
            if (entry.playedBy === playerName && entry.color !== 'Black' && freq[entry.color] !== undefined) {
                freq[entry.color]++;
            }
        }
        return freq;
    }

    /**
     * Get the color most commonly played by all opponents (excluding selfName).
     * @param {string} selfName - Robo's own name (excluded from count)
     * @returns {string} Most common color ('Red'|'Green'|'Blue'|'Yellow')
     */
    getMostPlayedColorByOpponents(selfName) {
        const freq = { Red: 0, Green: 0, Blue: 0, Yellow: 0 };
        for (const entry of this.playedCards) {
            if (entry.playedBy !== selfName && entry.color !== 'Black' && freq[entry.color] !== undefined) {
                freq[entry.color]++;
            }
        }
        return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
    }

    /**
     * Count how many Wild-family cards (color === 'Black') have been played
     * to the discard pile so far this round. Used to estimate how many of
     * the deck's 13 Wild-family cards remain unseen (draw pile + hands).
     * NOTE: only reflects cards actually retained in memory (bounded by
     * maxCards for Easy/Normal); Hard/Expert have Infinity so this is a
     * true full-round count for those tiers.
     * @returns {number}
     */
    getWildsPlayedCount() {
        return this.playedCards.filter(entry => entry.color === 'Black').length;
    }

    /**
     * Reset memory at the start of a new round.
     */
    reset() {
        this.playedCards = [];
    }
}

module.exports = { CardMemory };
