// @vitest-environment node
import assert from 'node:assert/strict';
import { expect, it } from 'vitest';
import {
  ActionRequestError,
  type ActionSubmission,
  defaultActionTransport as transport,
} from '../src/index.js';

const jsonRequest = (body: string, contentType = 'application/json') =>
  new Request('http://localhost/actions', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });

it.each([null, true, 42, 'text', [], [1, { nested: null }], { name: 'Group' }])(
  'preserves JSON body %j and its submission identifier',
  async (body) => {
    const payload = { intent: 'save', body, submissionId: 'submission-1' };
    const encoded = transport.encode(payload, 'application/json');
    assert(typeof encoded === 'string');
    await expect(transport.decode(jsonRequest(encoded))).resolves.toEqual(payload);
    expect(
      transport.inspect({ json: JSON.parse(encoded), formData: undefined, text: undefined })
    ).toEqual({ intent: 'save', submissionId: 'submission-1' });
  }
);

it.each(['application/json', 'text/plain'] as const)(
  'preserves a missing body as undefined with %s',
  async (encType) => {
    const encoded = transport.encode({ intent: 'save', body: undefined }, encType);
    assert(typeof encoded === 'string');
    expect(JSON.parse(encoded)).toEqual({ intent: 'save' });
    await expect(transport.decode(jsonRequest(encoded, encType))).resolves.toEqual({
      intent: 'save',
      body: undefined,
    });
  }
);

const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;

it.each([
  ['date', new Date()],
  ['file', new File(['content'], 'attachment.txt')],
  ['function', () => undefined],
  ['undefined in array', [undefined]],
  ['infinite number', Number.POSITIVE_INFINITY],
  ['nested NaN', { nested: [Number.NaN] }],
  ['bigint', 1n],
  ['symbol value', Symbol('value')],
  ['symbol property', { [Symbol('field')]: 'value' }],
  ['sparse array', new Array(1)],
  ['extra array property', Object.assign([1], { extra: true })],
  ['non-enumerable property', Object.defineProperty({}, 'field', { value: true })],
  [
    'accessor',
    {
      get field() {
        return true;
      },
    },
  ],
  ['cycle', cyclic],
])('rejects lossy JSON serialization: %s', (_label, body) => {
  expect(() => transport.encode({ intent: 'save', body }, 'application/json')).toThrow(
    ActionRequestError
  );
});

it('accepts shared object references without treating them as cycles', async () => {
  const reference = { value: 1 };
  const encoded = transport.encode(
    { intent: 'save', body: { first: reference, second: reference } },
    'application/json'
  );
  assert(typeof encoded === 'string');
  await expect(transport.decode(jsonRequest(encoded))).resolves.toEqual({
    intent: 'save',
    body: { first: { value: 1 }, second: { value: 1 } },
  });
});

it('preserves files and repeated form fields without mutating the input', async () => {
  const body = new FormData();
  body.append('tag', 'first');
  body.append('tag', 'second');
  body.append('file', new File(['content'], 'attachment.txt', { type: 'text/plain' }));
  const encoded = transport.encode(
    { intent: 'upload', body, submissionId: 'upload-1' },
    'multipart/form-data'
  );
  assert(encoded instanceof FormData);
  expect(body.has('__action_intent')).toBe(false);
  expect(body.has('__action_submission')).toBe(false);
  expect(transport.inspect({ formData: encoded, json: undefined, text: undefined })).toEqual({
    intent: 'upload',
    submissionId: 'upload-1',
  });
  const decoded = await transport.decode(
    new Request('http://localhost/actions', { method: 'POST', body: encoded })
  );
  assert(decoded?.body instanceof FormData);
  expect(decoded.intent).toBe('upload');
  expect(decoded.submissionId).toBe('upload-1');
  expect(decoded.body.getAll('tag')).toEqual(['first', 'second']);
  expect(decoded.body.has('__action_intent')).toBe(false);
  expect(decoded.body.has('__action_submission')).toBe(false);
  const file = decoded.body.get('file');
  assert(file instanceof File);
  expect(file.name).toBe('attachment.txt');
  expect(await file.text()).toBe('content');
});

it('preserves repeated FormData fields with URL encoding', async () => {
  const body = new FormData();
  body.append('tag', 'one');
  body.append('tag', 'two');
  const encoded = transport.encode({ intent: 'save', body }, 'application/x-www-form-urlencoded');
  assert(encoded instanceof FormData);
  expect(body.has('__action_intent')).toBe(false);
  const search = new URLSearchParams();
  for (const [key, value] of encoded) {
    assert(typeof value === 'string');
    search.append(key, value);
  }
  const decoded = await transport.decode(
    new Request('http://localhost/actions', { method: 'POST', body: search })
  );
  assert(decoded?.body instanceof FormData);
  expect(decoded.intent).toBe('save');
  expect(decoded.body.getAll('tag')).toEqual(['one', 'two']);
});

it('decodes a native form with a hidden intent field', async () => {
  const body = new URLSearchParams('__action_intent=save&name=Group');
  const decoded = await transport.decode(
    new Request('http://localhost/actions', { method: 'POST', body })
  );
  assert(decoded?.body instanceof FormData);
  expect(decoded.intent).toBe('save');
  expect([...decoded.body]).toEqual([['name', 'Group']]);
});

it('rejects files in URL-encoded bodies and reserved form fields', () => {
  const file = new FormData();
  file.append('file', new File(['content'], 'file.txt'));
  expect(() =>
    transport.encode({ intent: 'save', body: file }, 'application/x-www-form-urlencoded')
  ).toThrow(ActionRequestError);
  for (const field of ['__action_intent', '__action_submission']) {
    const body = new FormData();
    body.append(field, 'already-set');
    expect(() => transport.encode({ intent: 'save', body }, 'multipart/form-data')).toThrow(
      ActionRequestError
    );
  }
});

it('leaves unrecognized requests to the fallback without reading unsupported bodies', async () => {
  const unsupported = jsonRequest('arbitrary content', 'application/octet-stream');
  await expect(transport.decode(unsupported)).resolves.toBeUndefined();
  expect(unsupported.bodyUsed).toBe(false);
  await expect(
    transport.decode(
      new Request('http://localhost/actions', {
        method: 'POST',
        body: new URLSearchParams('name=Group'),
      })
    )
  ).resolves.toBeUndefined();
});

it.each([
  '',
  '{',
  '{"body":{}}',
  '{"intent":"","body":{}}',
  '{"intent":1,"body":{}}',
  '{"intent":"save","body":{},"other":true}',
  '{"intent":"save","body":{},"submissionId":null}',
])('rejects a malformed envelope: %s', async (body) => {
  await expect(transport.decode(jsonRequest(body))).rejects.toMatchObject({
    code: 'invalid-request',
  });
});

it.each([
  '__action_intent=save&__action_intent=archive',
  '__action_submission=submission-1',
  '__action_intent=save&__action_submission=one&__action_submission=two',
  '__action_intent=',
])('rejects malformed form metadata: %s', async (body) => {
  await expect(
    transport.decode(
      new Request('http://localhost/actions', {
        method: 'POST',
        body: new URLSearchParams(body),
      })
    )
  ).rejects.toBeInstanceOf(ActionRequestError);
});

it('uses the JSON envelope for text/plain submissions', async () => {
  const payload = { intent: 'save', body: ['text'], submissionId: 'text-1' };
  const encoded = transport.encode(payload, 'text/plain');
  assert(typeof encoded === 'string');
  await expect(transport.decode(jsonRequest(encoded, 'text/plain;charset=UTF-8'))).resolves.toEqual(
    payload
  );
  expect(transport.inspect({ text: encoded, json: undefined, formData: undefined })).toEqual({
    intent: 'save',
    submissionId: 'text-1',
  });
});

it.each<ActionSubmission>([
  { json: undefined, formData: undefined, text: undefined },
  { json: { unrelated: true }, formData: undefined, text: undefined },
  { json: undefined, formData: new FormData(), text: undefined },
  { json: undefined, formData: undefined, text: 'not JSON' },
])('ignores unrecognized or malformed submissions during pending inspection', (submission) => {
  expect(transport.inspect(submission)).toBeUndefined();
});

it.each(['multipart/form-data', 'application/x-www-form-urlencoded'] as const)(
  'supports a bodyless action with %s',
  async (encType) => {
    const encoded = transport.encode({ intent: 'archive', body: undefined }, encType);
    assert(encoded instanceof FormData);
    expect([...encoded]).toEqual([['__action_intent', 'archive']]);
    const decoded = await transport.decode(
      new Request('http://localhost/actions', { method: 'POST', body: encoded })
    );
    assert(decoded?.body instanceof FormData);
    expect(decoded.intent).toBe('archive');
    expect([...decoded.body]).toEqual([]);
  }
);

it.each(['multipart/form-data', 'application/x-www-form-urlencoded'] as const)(
  'rejects URLSearchParams with %s to preserve the handler input type',
  (encType) => {
    const body = new URLSearchParams('tag=one&tag=two');
    expect(() => transport.encode({ intent: 'save', body }, encType)).toThrow(ActionRequestError);
    expect(body.toString()).toBe('tag=one&tag=two');
  }
);

it('omits undefined object properties following JSON semantics', async () => {
  const body = { name: 'Vote', comment: undefined, nested: { optional: undefined, count: 1 } };
  const encoded = transport.encode({ intent: 'save', body }, 'application/json');
  assert(typeof encoded === 'string');
  await expect(transport.decode(jsonRequest(encoded))).resolves.toEqual({
    intent: 'save',
    body: { name: 'Vote', nested: { count: 1 } },
  });
  expect(Object.hasOwn(body, 'comment')).toBe(true);
  expect(Object.hasOwn(body.nested, 'optional')).toBe(true);
});
