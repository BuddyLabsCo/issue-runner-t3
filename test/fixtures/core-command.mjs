#!/usr/bin/env node
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// Simulate only the disposable Issue and Git evidence Core needs. Unexpected commands fail closed.
const file = process.env.FIXTURE_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
const save = () => writeFileSync(file, JSON.stringify(state));
const args = process.argv.slice(2);
const base = 'a'.repeat(40);
const [tool] = basename(process.argv[1]).split('.');
if (tool === 'git') {
  if (args[0] === '-c') args.splice(0, 2);
  if (args[0] === 'fetch') {
    assert.equal(process.cwd(), state.checkout);
    assert.deepEqual(args, ['fetch', '--no-tags', 'origin', 'main']);
  } else if (args.join(' ') === 'rev-parse FETCH_HEAD') console.log(base);
  else if (args[0] === 'worktree' && args[1] === 'add') {
    assert.equal(process.cwd(), state.checkout);
    assert.equal(args[5], base);
    state.branch = args[3];
    state.worktree = args[4];
    mkdirSync(state.worktree, { recursive: true });
    save();
  } else if (args.join(' ') === 'rev-parse --show-toplevel') console.log(process.cwd());
  else if (args.join(' ') === 'branch --show-current') console.log(state.branch);
  else if (args[0] === 'merge-base') console.log(base);
  else if (['status', 'log', 'diff', 'check-ref-format', 'for-each-ref'].includes(args[0])) {}
  else if (args[0] === 'worktree' && args[1] === 'list') {}
  else assert.fail(`Unexpected git command: ${args.join(' ')}`);
} else if (tool === 'gh') {
  const viewer = { __typename: 'User', id: 'U1', login: 'runner' };
  const repo = { id: 'R1', nameWithOwner: 'fixture/repo' };
  const reservation = { id: 'L1', name: 'fixture:reserved' };
  const page = nodes => ({ nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: nodes.length ? 'end' : null } });
  const labels = () => state.reserved ? [reservation] : [];
  const assignees = () => state.reserved ? [viewer] : [];
  const issue = () => ({ id: 'I1', number: 42, state: state.closed ? 'CLOSED' : 'OPEN', stateReason: state.closed ? 'COMPLETED' : null,
    repository: repo, title: 'Fixture', body: 'Already satisfied.', url: 'https://example.test/issue/42',
    labels: page(labels()), assignees: page(assignees()), blockedBy: page([]) });
  if (args[1] === 'graphql') {
    const { query } = JSON.parse(readFileSync(0, 'utf8'));
    let data;
    if (query.includes('query IssueStart')) data = { repository: { ...repo, label: reservation, target: issue() }, viewer };
    else if (query.includes('mutation ReserveIssue')) {
      state.reserved = true;
      save();
      data = { addReservation: { labelable: issue() }, addRunner: { assignable: issue() } };
    } else if (query.includes('query Viewer')) data = { viewer };
    else assert.fail(`Unexpected GraphQL query: ${query}`);
    console.log(JSON.stringify({ data }));
  } else if (args[0] === 'issue' && args[1] === 'close') {
    state.closed = true;
    save();
  } else if (args[3] === 'repos/fixture/repo/issues/42') {
    console.log(JSON.stringify({ number: 42, state: state.closed ? 'closed' : 'open', state_reason: state.closed ? 'completed' : null,
      title: 'Fixture', body: 'Already satisfied.', html_url: 'https://example.test/issue/42', labels: labels(), assignees: assignees() }));
  } else if (args[3] === 'repos/fixture/repo/issues/42/dependencies/blocked_by') console.log('[]');
  else if (args[3] === 'repos/fixture/repo/issues/42/comments') console.log('{}');
  else assert.fail(`Unexpected gh command: ${args.join(' ')}`);
} else assert.fail(`Unexpected tool: ${tool}`);
