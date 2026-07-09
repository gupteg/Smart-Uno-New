'use strict';

/**
 * Player class hierarchy.
 *
 * Player        → base class (shared properties)
 *   HumanPlayer → no AI; moves come from socket events
 *   RoboPlayer  → moves come from Strategy.selectMove()
 *
 * IMPORTANT: RoboPlayer instances live in the server-side roboInstances Map.
 * They are NOT serialised into gameState (which must remain plain JSON for
 * socket.io to broadcast it). Only the lightweight flags
 * { isRobo:true, difficulty:'Hard' } are stored in gameState.players[].
 */

const { StrategyFactory } = require('./strategy');

class Player {
    constructor(playerId, socketId, name, isHost = false) {
        this.playerId = playerId;
        this.socketId = socketId;
        this.name     = name;
        this.isHost   = isHost;
        this.isRobo   = false;
    }
}

class HumanPlayer extends Player {
    constructor(playerId, socketId, name, isHost = false) {
        super(playerId, socketId, name, isHost);
        this.isRobo = false;
    }
}

/**
 * RoboPlayer — encapsulates the AI brain for one robo seat.
 *
 * Only the server holds these instances; they are never sent to clients.
 * The game engine interacts exclusively through makeMove() and recordCard().
 */
class RoboPlayer {
    /**
     * @param {string} playerId  - Unique ID (stored in gameState too)
     * @param {string} name      - Display name
     * @param {string} difficulty - 'Easy'|'Normal'|'Hard'|'Expert'
     */
    constructor(playerId, name, difficulty = 'Normal') {
        this.playerId   = playerId;
        this.name       = name;
        this.difficulty = difficulty;
        this.isRobo     = true;
        this.strategy   = StrategyFactory.create(difficulty);
        this.memory     = StrategyFactory.createMemory(difficulty);
    }

    /**
     * Ask the robo for its next move.
     * Async-ready: swap strategy for an ML model without changing this call-site.
     * @param {object} gs           - Current game state (read-only from robo's POV)
     * @param {number} playerIndex  - Robo's index in gs.players
     * @returns {Promise<object>}   - Move object
     */
    async makeMove(gs, playerIndex) {
        return this.strategy.selectMove(gs, playerIndex, this.memory);
    }

    /**
     * Record a card played to the discard pile (by ANY player).
     * Called by the game engine after every successful play.
     * @param {{color:string,value:string}} card
     * @param {string} playerName
     */
    recordCard(card, playerName) {
        this.memory.recordCard(card, playerName);
    }

    /** Reset memory at the start of a new round. */
    resetMemory() {
        this.memory.reset();
    }
}

module.exports = { Player, HumanPlayer, RoboPlayer };
