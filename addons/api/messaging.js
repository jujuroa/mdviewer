// The messaging area (protocol 13.14): frames of one add-on talk to each
// other. deps:
//   frames(caller, to) -> the add-on's other frames that are ready
//     ('background' | 'tabs' | 'all'), the caller's own left out; post
//     starts nothing
//   background(caller) -> Promise<target | null> its background frame,
//     started and ready (null: it has none, or it would not start)
//   send(frame, message, from) — onMessage handlers get it
//   request(target, message, from) -> Promise<{ ok, result } | { ok: false, error }>
// from: { kind, tabId?, instanceId? } — who sent it, as the receiver sees it.
const { ApiError } = require('../api-router.js');

const MESSAGE_MAX_BYTES = 1024 * 1024;
const TARGETS = ['background', 'tabs', 'all'];

function message(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    throw new ApiError('InvalidParams', 'message must be JSON');
  }
  if (json === undefined) throw new ApiError('InvalidParams', 'message must be JSON');
  if (Buffer.byteLength(json, 'utf8') > MESSAGE_MAX_BYTES) throw new ApiError('TooLarge', 'message is over 1 MiB');
  return JSON.parse(json);
}

function fromOf(caller) {
  if (caller.kind === 'background') return { kind: 'background' };
  if (caller.kind === 'pane') return { kind: 'pane', tabId: null, instanceId: caller.tab.id };
  return { kind: 'tab', tabId: caller.tab.addon.tabId, instanceId: caller.tab.id };
}

function registerMessagingApi(router, deps) {
  router.register('messaging/post', {
    handler: (caller, params) => {
      if (!TARGETS.includes(params.to)) throw new ApiError('InvalidParams', 'to must be "background", "tabs" or "all"');
      const msg = message(params.message);
      const from = fromOf(caller);
      for (const frame of deps.frames(caller, params.to)) deps.send(frame, msg, from);
      return null;
    },
  });

  router.register('messaging/request', {
    handler: async (caller, params) => {
      if (params.to !== 'background') throw new ApiError('InvalidParams', 'to must be "background"');
      if (caller.kind === 'background') throw new ApiError('InvalidParams', 'The background frame cannot ask itself');
      const msg = message(params.message);
      const target = await deps.background(caller);
      if (!target) throw new ApiError('NotFound', 'This add-on has no background frame running');
      const answer = await deps.request(target, msg, fromOf(caller));
      if (answer && answer.ok) return answer.result === undefined ? null : answer.result;
      const error = (answer && answer.error) || {};
      throw new ApiError(error.name === 'RequestCancelled' ? 'RequestCancelled' : 'InternalError', error.message || 'The background frame failed to answer');
    },
  });
}

module.exports = { registerMessagingApi, fromOf };
