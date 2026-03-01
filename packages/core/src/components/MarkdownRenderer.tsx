import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { computed } from '@preact/signals';
import { annotations, elements, sheetOpen, sheetTarget, editingGeneralIdx, dismissed } from '../state';
import { highlightCode } from '../highlighter';
import { QuestionBlock } from './QuestionBlock';
import type { QuestionElement, CodeElement } from '../types';
import type { Components } from 'react-markdown';
import type { Element as HastElement } from 'hast';

// Precomputed map from source line → element index (memoized via computed)
const lineMap = computed(() => {
  const map = new Map<number, number>();
  elements.value.forEach((el, idx) => {
    map.set(el.lineStart, idx);
  });
  return map;
});

function getIndex(node?: HastElement): number {
  const line = (node?.position?.start?.line ?? 1) - 1;
  return lineMap.value.get(line) ?? -1;
}

function openBlockSheet(idx: number) {
  sheetTarget.value = idx;
  editingGeneralIdx.value = undefined;
  sheetOpen.value = true;
}

function copyCode(content: string) {
  navigator.clipboard.writeText(content).catch(() => {});
}

// Extract raw text from a HAST node tree
function hastText(node: any): string {
  if (node.type === 'text') return node.value || '';
  if (node.value) return node.value;
  if (node.children) return node.children.map(hastText).join('');
  return '';
}

function AnnotatableBlock({ index, children, className, style }: {
  index: number;
  children: any;
  className?: string;
  style?: Record<string, string>;
}) {
  if (index < 0) return <div class={className}>{children}</div>;
  const hasAnn = !!annotations.value[index];
  return (
    <div
      class={`block ${className || ''}`}
      id={`el-${index}`}
      onClick={() => openBlockSheet(index)}
      style={style}
    >
      {hasAnn && <div class="ann-dot"></div>}
      {children}
    </div>
  );
}

// Track whether we're inside a list item to suppress <p> wrapping
let insideListItem = false;

// Determine the el-* class for a list item based on parent list type
function getListItemClass(node?: HastElement): string {
  if (!node?.position?.start?.line) return 'el-li';
  const line = node.position.start.line - 1;
  const idx = lineMap.value.get(line);
  if (idx === undefined) return 'el-li';
  const el = elements.value[idx];
  return el?.type === 'ol' ? 'el-ol' : 'el-li';
}

const components: Components = {
  h1({ children, node }) {
    return <AnnotatableBlock index={getIndex(node)} className="el-h1">{children}</AnnotatableBlock>;
  },
  h2({ children, node }) {
    return <AnnotatableBlock index={getIndex(node)} className="el-h2">{children}</AnnotatableBlock>;
  },
  h3({ children, node }) {
    return <AnnotatableBlock index={getIndex(node)} className="el-h3">{children}</AnnotatableBlock>;
  },
  p({ children, node }) {
    // Inside list items, <p> is an artifact of tight/loose list parsing — pass through
    if (insideListItem) return <>{children}</>;
    return <AnnotatableBlock index={getIndex(node)} className="el-p">{children}</AnnotatableBlock>;
  },
  li({ children, node }) {
    const cls = getListItemClass(node);
    insideListItem = true;
    try {
      return (
        <AnnotatableBlock index={getIndex(node)} className={cls}>{children}</AnnotatableBlock>
      );
    } finally {
      insideListItem = false;
    }
  },
  blockquote({ children, node }) {
    return <AnnotatableBlock index={getIndex(node)} className="el-quote">{children}</AnnotatableBlock>;
  },
  table({ children, node }) {
    return (
      <AnnotatableBlock index={getIndex(node)} className="el-table">
        <table>{children}</table>
      </AnnotatableBlock>
    );
  },
  img({ node, ...props }) {
    return (
      <AnnotatableBlock index={getIndex(node)} className="el-p">
        <img {...props} />
      </AnnotatableBlock>
    );
  },
  // Inline code
  code({ children, className }) {
    if (!className) return <code class="inline">{children}</code>;
    return <code class={className}>{children}</code>;
  },
  // Fenced code blocks (and question blocks)
  pre({ node }) {
    const codeChild = node?.children?.[0] as HastElement | undefined;
    const cls = (codeChild?.properties?.className as string[] | undefined)?.[0] || '';
    const lang = cls.replace('language-', '');
    const code = codeChild ? hastText(codeChild) : '';
    const idx = getIndex(node);

    // Question blocks
    if (lang.startsWith('question:')) {
      const el = elements.value[idx] as QuestionElement | undefined;
      if (el && el.type === 'question' && !dismissed.value[el.id]) {
        return <QuestionBlock key={el.id} el={el} index={idx} />;
      }
      // If the element is not a valid question (e.g. invalid qtype),
      // fall through to render as a regular code block
      if (el && el.type !== 'code') return null;
    }

    // Regular code blocks
    const hasAnn = idx >= 0 && !!annotations.value[idx];
    return (
      <div
        class="block"
        id={idx >= 0 ? `el-${idx}` : undefined}
        onClick={idx >= 0 ? () => openBlockSheet(idx) : undefined}
        style={{ padding: 0, margin: '2px -6px' }}
      >
        <div class="code-wrap">
          {hasAnn && (
            <div class="ann-dot" style={{ position: 'absolute', right: '8px', top: '8px', zIndex: 2 }}></div>
          )}
          <div class="code-header">
            <span class="code-lang">{lang}</span>
            <button
              class="code-copy"
              onClick={(e: Event) => { e.stopPropagation(); copyCode(code); }}
            >
              copy
            </button>
          </div>
          {(() => {
            const html = highlightCode(code, lang);
            if (html) return <div class="code-body" dangerouslySetInnerHTML={{ __html: html }} />;
            return <div class="code-body"><pre><code>{code}</code></pre></div>;
          })()}
        </div>
      </div>
    );
  },
  // Strip list wrappers — items are individually wrapped by li component
  ul({ children }) {
    return <>{children}</>;
  },
  ol({ children }) {
    return <>{children}</>;
  },
};

interface MarkdownRendererProps {
  markdown: string;
}

// Sanitize schema: extend defaults to allow img width/height and SVG elements
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames || []),
    'svg', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse',
    'path', 'text', 'tspan', 'g', 'defs', 'use', 'symbol',
    'animate', 'animateMotion', 'animateTransform', 'set',
    'clipPath', 'mask', 'pattern', 'linearGradient', 'radialGradient', 'stop',
    'filter', 'feGaussianBlur', 'feOffset', 'feMerge', 'feMergeNode',
    'marker', 'mpath',
  ],
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img || []), 'width', 'height'],
    svg: ['viewBox', 'xmlns', 'width', 'height', 'fill', 'stroke', 'class', 'style', 'role', 'aria-*'],
    circle: ['cx', 'cy', 'r', 'fill', 'stroke', 'strokeWidth', 'stroke-width', 'opacity', 'class'],
    rect: ['x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'stroke', 'stroke-width', 'opacity', 'class'],
    line: ['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width', 'class'],
    ellipse: ['cx', 'cy', 'rx', 'ry', 'fill', 'stroke', 'stroke-width', 'class'],
    path: ['d', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'class', 'opacity'],
    polyline: ['points', 'fill', 'stroke', 'stroke-width', 'class'],
    polygon: ['points', 'fill', 'stroke', 'stroke-width', 'class'],
    text: ['x', 'y', 'dx', 'dy', 'textAnchor', 'text-anchor', 'fill', 'fontSize', 'font-size', 'fontFamily', 'font-family', 'class'],
    tspan: ['x', 'y', 'dx', 'dy', 'fill', 'class'],
    g: ['transform', 'fill', 'stroke', 'class', 'opacity'],
    use: ['href', 'x', 'y', 'width', 'height'],
    symbol: ['viewBox', 'id'],
    animate: ['attributeName', 'values', 'dur', 'repeatCount', 'begin', 'fill', 'from', 'to'],
    animateMotion: ['dur', 'repeatCount', 'path', 'begin', 'fill'],
    animateTransform: ['attributeName', 'type', 'from', 'to', 'dur', 'repeatCount', 'begin', 'fill', 'values'],
    set: ['attributeName', 'to', 'begin', 'dur'],
    linearGradient: ['id', 'x1', 'y1', 'x2', 'y2', 'gradientUnits'],
    radialGradient: ['id', 'cx', 'cy', 'r', 'fx', 'fy', 'gradientUnits'],
    stop: ['offset', 'stopColor', 'stop-color', 'stopOpacity', 'stop-opacity'],
    clipPath: ['id'],
    mask: ['id'],
    filter: ['id', 'x', 'y', 'width', 'height'],
    mpath: ['href'],
    marker: ['id', 'viewBox', 'refX', 'refY', 'markerWidth', 'markerHeight', 'orient'],
  },
};

export function MarkdownRenderer({ markdown }: MarkdownRendererProps) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]} components={components}>
      {markdown}
    </Markdown>
  );
}
