'use strict';

const g = new Function("return this")();

const debug = require('debug')('sc2:debug:proto');
const WebSocket = g.WebSocket || require("ws");
const protobuf = require('protobufjs/light');
const taskQueue = require('promise-task-queue');
const promiseFromEvent = require('event-to-promise');
const createEventEmitter = require('create-event-emitter');

const sc2 = protobuf.Root.fromJSON(require('./proto-bundle.js'));

const Request = sc2.lookupType('Request');
const Response = sc2.lookupType('Response');

/**
 * this extracts the possible Request/Response types from the `oneof` def:
 *
 * 'createGame', 'joinGame', 'restartGame', 'startReplay', 'leaveGame',
 * 'quickSave', 'quickLoad', 'quit', 'gameInfo', 'observation', 'action',
 * 'obsAction', 'step', 'data', 'query', 'saveReplay', 'replayInfo',
 * 'availableMaps', 'saveMap', 'mapCommand', 'ping', 'debug'
 **/
let responseTypes = Response.oneofs.response.oneof;

// Add the error response type, so errors can be properly handled.
responseTypes.push("error");

/** map the Request/Response types to an array of objs with meta data */
const responses = Response.fieldsArray.map((field) => ({
	name: field.name,
	type: field.type,
	errorType: `field.type:${Error}`,
}));

/**
 * convenience wrapper for creating the event emitter functions
 */
function queueWrapper(responseName, successEvent, errorEvent) {
	return function (err, res) {
		if (err) {
			this.emit(errorEvent, err);
		} else {
			this.emit(successEvent, res[responseName]);
		}
	};
}

/**
 * creates an event emitter with a unique event per request type
 */
function createApiQueue() {
	return createEventEmitter(
		responses.reduce((fns, entry) => {
			return {
				...fns,
				[entry.name]: queueWrapper(
					entry.name,
					entry.type,
					entry.errorType,
				),
			};
		}, {}));
}

/**
 * creates a unique payload creation and push-to-queue function per request type
 * @returns {NodeSC2Proto.ApiFunctions}
 */
function createApiFunctions() {
	function responseReducer(acc, entry) {
		function protoAPIFunction(req = {}) {
			const request = Request.create({ [entry.name]: req });
			const payload = Request.encode(request).finish();

			return this._promiseQueue.push(entry.name, payload);
		}

		return {
			...acc,
			[entry.name]: protoAPIFunction,
		};
	}

	return responses.reduce(responseReducer, {});
}

/**
 * creates a promise queue to enforce single-concurrency on a
 * per-request type basis. this function *must* be bound to the
 * proto client before a new queue is created, due to the queue
 * task functions being invoked on the queue manager.
 */
function createPromiseQueue() {
	const queue = taskQueue();

	responses.forEach((entry) => {
		queue.define(entry.name, (payload) => {
			const promise = promiseFromEvent(
				this._protoApiQueue,
				entry.type,
				{ error: entry.errorType }
			);

			this._request(payload);
			return promise;
		}, { concurrency: 1 });
	});

	return queue;
}

function createConnection({ host = '127.0.0.1', port = 5000 }) {
	return new WebSocket(`ws://${host}:${port}/sc2api`);
}

function createProtoClient() {
	const _ws = null;
	const status = 99;
	const apiQueue = createApiQueue();
	apiQueue.setMaxListeners(24);

	// @TODO should we be exposing the websocket itself like this?
	/** @type {NodeSC2Proto.ProtoClient} */
	const client = {
		...createApiFunctions(),
		_ws,
		async connect(opts) {

			this._ws = createConnection(opts);

			const onMessage = async (res) => {
				let err;

				if(res.data) {
					// TODO: Serialize this, as technically this makes it possible to handle messages out of order
					res = new Buffer(await res.data.arrayBuffer());
				}

				//@ts-ignore i promise you it's not a string
				const responseMessage = Response.decode(res);

				/** @type {SC2APIProtocol.Response} */
				const response = Response.toObject(responseMessage, {
					longs: String, // default uint64's to strings
					defaults: true, // populates empty arrays and objects instead of dropping
				});

				if (response.status) {
					this.status = response.status;
				}

				if (response.error && response.error.length > 0) {
					err = Object.assign(
						new Error(`Response Error: ${JSON.stringify(response.error, null, 2)}`),
						{ err: response.error },
					);
				}

				const responseType = responseTypes.find(type => response[type]);

				const callbackHandler = this._protoApiQueue[responseType];
				if (!callbackHandler) {
					debug("WARNING: response received with no valid response type handler: ", response)
				} else {
					this._protoApiQueue[responseType](err, response);
				}
			};

			if(this._ws.on) {
				this._ws.on('message', onMessage);

				this._ws.on('error', console.warn);
				this._ws.on('close', () => debug('CONNECTION CLOSED'));
			} else {
				this._ws.onmessage = onMessage;

				this._ws.onerror = console.warn;
				this._ws.onclose = () => debug('CONNECTION CLOSED');
			}

			await promiseFromEvent(this._ws, 'open');

			debug(`successfully connected to sc2 client on port ${opts.port}`);

			return this.ping();
		},
		status,
		_request(requestBuffer) {
			this._ws.send(requestBuffer);
		},
		_protoApiQueue: apiQueue,
	};

	client._promiseQueue = createPromiseQueue.bind(client)();
	return client;
}

module.exports = createProtoClient;
