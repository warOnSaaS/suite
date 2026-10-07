// Just enough Markdown for answers: paragraphs, headings, lists, bold, inline code, code blocks and links.
// Builds React elements, never HTML strings, so nothing a model writes can run as code.
import { Fragment, type ReactNode } from 'react';

function inline(s: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<b key={`${key}-${m.index}`}>{t.slice(2, -2)}</b>);
    else if (t.startsWith('`')) out.push(<code key={`${key}-${m.index}`}>{t.slice(1, -1)}</code>);
    else { const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!; out.push(<a key={`${key}-${m.index}`} href={href} target={href.startsWith('/') ? undefined : '_blank'} rel="noreferrer" data-tool="none" data-why="opens a link">{label}</a>); }
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={i} className="wos-code"><code>{code.join('\n')}</code></pre>);
      continue;
    }
    if (/^#{1,4}\s/.test(l)) { blocks.push(<p key={i} className="wos-h"><b>{inline(l.replace(/^#+\s/, ''), i)}</b></p>); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s/, ''));
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(<Tag key={i} className="wos-list">{items.map((it, k) => <li key={k}>{inline(it, k)}</li>)}</Tag>);
      continue;
    }
    if (!l.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={i}>{para.map((p, k) => <Fragment key={k}>{k > 0 && <br />}{inline(p, k)}</Fragment>)}</p>);
  }
  return <>{blocks}</>;
}
