import EventEmitter from 'events'

import WebSocket from 'ws'
import { v4 as uuidV4 } from 'uuid'

import middleware from '../middleware'
import { limit } from '../../utils'
import logger from '../../logger'

const WEBSOCKET_PORT = 9222

/**
 * Page model
 * ==========
 *
 * Manages connection between: Device (TV) <--> Devtools backend <--> Devtools frontend. Each
 * page can be identified by an UUID where ids between device (TV) and devtools backend might
 * change over time due to page reloads.
 *
 * Device (TV) <--> Devtools backend connection:
 * Handled by a socket.io connection (for compatibility issues)
 *
 * Devtools backend <--> Devtools frontend
 * Handles by a standard socket connection (WS).
 */
export default class Page extends EventEmitter {
    constructor (io, uuid = uuidV4()) {
        super()
        this.uuid = uuid
        this.log = logger('Page')
        this.isConnected = false
        this.domains = []

        this.io = io.of(`/${uuid}`)
        this.io.on('connection', ::this.connect)
        this.io.on('disconnected', ::this.disconnect)

        this.socket = new WebSocket.Server({
            perMessageDeflate: false,
            noServer: true
        })
        this.socket.on('connection', ::this.connectWebSocket)
    }

    /**
     * Connect to device (TV)
     */
    connect (socket) {
        this.log.debug(`Connected to device with page id ${this.uuid}`)

        this.socket = socket
        this.socket.on('result', ::this.send)
        this.socket.on('connection', (msg) => {
            this.enable(msg.supportedDomains)
            this.log.info(
                `debugger connection: ${msg.status},\n` +
                `supported domains: ${this.domains.join(',')}`
            )
        })
        this.socket.on('debug', (msg) => this.log.debug(msg))
    }

    /**
     * Disconnect from device (TV)
     */
    disconnect () {
        this.log.debug(`Disconnected from page ${this.uuid}`)
        delete this.socket
    }

    /**
     * Connect to devtools frontend
     */
    connectWebSocket (ws) {
        this.log.debug(`Connected to devtools-frontend page ${this.uuid}`)

        this.ws = ws
        this.ws.on('message', ::this.handleIncomming)
        this.ws.on('open', () => (this.isConnected = true))
        this.ws.on('close', () => ::this.disconnectWebSocket)
    }

    /**
     * Disconnect from devtools frontend
     */
    disconnectWebSocket () {
        this.isConnected = false
        this.log.debug(`Disconnect from devtools-frontend page ${this.uuid}`)
        delete this.ws
    }

    /**
     * enable domain for page
     *
     * @param {String|String[]} domain  domain(s) to enable
     */
    enable (domain) {
        if (Array.isArray(domain)) {
            return domain.forEach((domain) => this.enable(domain))
        }

        if (this.domains.includes(domain)) {
            return this.log(`Domain "${domain}" already enabled for page ${this.uuid}`)
        }

        this.log.info(`Enable domain ${domain} for page ${this.uuid}`)
        this.emit('domainEnabled', domain)
        this.domains.push(domain)
    }

    /**
     * disable domain for page
     */
    disable (domain) {
        this.log.info(`Disable domain ${domain} for page ${this.uuid}`)
        const pos = this.domains.indexOf(domain)
        this.domains.splice(pos, pos + 1)
    }

    /**
     * check if domain is currently supported/enabled
     * Usage:
     *  - isDomainSupported({ method: 'Network.loadingFinished', params: { ... }})
     *  - isDomainSupported('Network')
     *
     * @param   [Object|String] msg  either:
     *                                 - a WS message like first example above or
     *                                 - string if you want to specify the domain directly
     * @returns [Boolean]            true if the specified domain is supported/enabled
     */
    isDomainSupported (msg) {
        if (typeof msg === 'string') {
            return this.domains.includes(msg)
        }

        const method = msg.method || ''
        const splitPoint = method.indexOf('.')
        return this.domains.includes(method.slice(0, splitPoint))
    }

    /**
     * Handle incomming debugger request.
     * Incomming can be either (but mostly) messages from the devtools app directly
     * or from other parts of the app (e.g. proxy)
     *
     * @param {Object|String} payload  message with command and params
     */
    handleIncomming (payload) {
        const msg = typeof payload === 'string' ? JSON.parse(payload) : payload
        const splitPoint = msg.method.indexOf('.')
        const domain = msg.method.slice(0, splitPoint)
        const method = msg.method.slice(splitPoint + 1)

        /**
         * enable domain agent
         */
        if (method === 'enable' && this.isDomainSupported(domain)) {
            this.enable(domain)
            return this.send({ id: msg.id, params: {} })
        }

        /**
         * disable domain agent
         */
        if (method === 'disable') {
            this.disable(domain)
            return this.emit({ id: msg.id, params: {} })
        }

        /**
         * don't propagate domains that are not supported or disabled
         */
        if (!this.isDomainSupported(msg)) {
            return
        }

        this.emit('incomming', { method, domain, msg })
    }

    /**
     * emits payload to devtools frontend
     * @param  {Object} msg  payload to send
     */
    send (msg) {
        if (!this.ws) {
            return
        }

        /**
         * check for server side domain handlers
         */
        if (middleware[msg._domain] && middleware[msg._domain][msg._method]) {
            const result = middleware[msg._domain][msg._method].call(this, msg.result, this.requestList)
            return this.send({ id: msg.id, result })
        }

        delete msg._domain
        delete msg._method

        const msgString = JSON.stringify(msg)
        this.log.debug(`Outgoing debugger message: ${limit(msgString)}`)

        /**
         * broadcast to clients that have open socket connection
         */
        if (this.ws.readyState !== WebSocket.OPEN) {
            return
        }

        return this.ws.send(msgString)
    }
}

export { WEBSOCKET_PORT }