import ReactMarkdown, { type Components } from "react-markdown";

// Shared renderer for LLM-generated analysis / report bodies. The text
// is Markdown (headings, lists, inline code, …) and is rendered as real
// elements styled with the design-system tokens rather than printed
// verbatim. Raw HTML is intentionally NOT enabled (no `rehype-raw`), so
// any HTML the LLM emits is treated as inert text and never injected.
//
// `<<UNVERIFIED_*>>` markers — entities the LLM emitted that were not
// present in the original event (RFC 0001 §"UI — analysis result page") —
// are highlighted as rose-coloured badges. They are split out at the hast
// (post-Markdown AST) level rather than by slicing the raw Markdown
// string, so list / paragraph structure around a marker stays intact. The
// loader has already restored real `<<REDACTED_*>>` tokens to their entity
// values; only these unverified markers need special treatment here.
const UNVERIFIED_MARKER_RE = /<<UNVERIFIED_(?:IP|EMAIL|MAC)_\d+>>/g;

// Minimal structural subset of the hast nodes this plugin reads/writes.
// react-markdown does not re-export hast's types as a direct dependency,
// so we model only the fields we touch.
interface HastText {
  type: "text";
  value: string;
}
interface HastElement {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
  children: HastNode[];
}
type HastNode =
  | HastText
  | HastElement
  | { type: string; children?: HastNode[] };

// Split a text node's value into alternating plain-text nodes and
// `unverified-marker` element nodes wherever a marker appears.
function splitTextNode(value: string): HastNode[] {
  const out: HastNode[] = [];
  let last = 0;
  // The regex is global; reset before reuse so a prior call's lastIndex
  // does not leak into this scan.
  UNVERIFIED_MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null = UNVERIFIED_MARKER_RE.exec(value);
  while (match !== null) {
    if (match.index > last) {
      out.push({ type: "text", value: value.slice(last, match.index) });
    }
    out.push({
      type: "element",
      tagName: "unverified-marker",
      properties: {},
      children: [{ type: "text", value: match[0] }],
    });
    last = match.index + match[0].length;
    match = UNVERIFIED_MARKER_RE.exec(value);
  }
  if (last < value.length) {
    out.push({ type: "text", value: value.slice(last) });
  }
  return out;
}

// rehype plugin: append a `citation-chip` element to the END of the unit's
// inline flow so the citation link renders inline right after the sentence
// text rather than dropping onto its own line below the block paragraph
// (#449 review round 1). The chip is appended INSIDE the last paragraph when
// the unit ends in one (the common single-sentence case), so it sits
// immediately after the final word; otherwise (a unit ending in a list,
// code block, …) it is appended as a trailing block after the last element.
// The `citation-chip` node is mapped to the actual `<Link>` by a per-render
// component override in `AnalysisMarkdown` (it carries no properties — the
// closure supplies the link), mirroring the `unverified-marker` pattern.
function rehypeAppendCitationChip() {
  const chip: HastElement = {
    type: "element",
    tagName: "citation-chip",
    properties: {},
    children: [],
  };
  return (tree: HastNode): void => {
    const children = (tree as HastElement).children;
    if (!children || children.length === 0) {
      (tree as HastElement).children = [chip];
      return;
    }
    const last = children[children.length - 1];
    if (last.type === "element" && (last as HastElement).tagName === "p") {
      (last as HastElement).children.push(chip);
    } else {
      children.push(chip);
    }
  };
}

// rehype plugin: walk the tree and replace `<<UNVERIFIED_*>>` substrings
// inside text nodes with `unverified-marker` element nodes that the
// component map below renders as badges.
function rehypeUnverifiedMarkers() {
  function visit(node: HastNode): void {
    const children = (node as HastElement).children;
    if (!children) return;
    const next: HastNode[] = [];
    for (const child of children) {
      if (child.type === "text" && "value" in child) {
        if (child.value.includes("<<UNVERIFIED_")) {
          next.push(...splitTextNode(child.value));
        } else {
          next.push(child);
        }
      } else {
        visit(child);
        next.push(child);
      }
    }
    (node as HastElement).children = next;
  }
  return (tree: HastNode): void => {
    visit(tree);
  };
}

// Map Markdown elements onto explicit design-system classes. The Tailwind
// typography plugin is not in the project, so each tag carries its own
// classes rather than relying on a `prose` wrapper. The `Components`
// annotation contextually types each renderer's props.
const ELEMENT_COMPONENTS: Components = {
  h1: ({ node: _node, ...props }) => (
    <h1
      className="mb-2 mt-4 text-base font-bold text-foreground first:mt-0"
      {...props}
    />
  ),
  h2: ({ node: _node, ...props }) => (
    <h2
      className="mb-2 mt-4 text-sm font-semibold text-foreground first:mt-0"
      {...props}
    />
  ),
  h3: ({ node: _node, ...props }) => (
    <h3
      className="mb-1 mt-3 text-sm font-semibold text-foreground first:mt-0"
      {...props}
    />
  ),
  h4: ({ node: _node, ...props }) => (
    <h4
      className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground first:mt-0"
      {...props}
    />
  ),
  p: ({ node: _node, ...props }) => <p className="mb-2 last:mb-0" {...props} />,
  ul: ({ node: _node, ...props }) => (
    <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0" {...props} />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0" {...props} />
  ),
  li: ({ node: _node, ...props }) => <li className="pl-1" {...props} />,
  a: ({ node: _node, ...props }) => (
    <a
      className="font-medium text-primary underline underline-offset-2"
      {...props}
    />
  ),
  code: ({ node: _node, ...props }) => (
    <code
      className="rounded bg-muted px-1 py-0.5 font-mono text-xs [pre_&]:bg-transparent [pre_&]:p-0"
      {...props}
    />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre
      className="mb-2 overflow-x-auto rounded bg-muted p-3 font-mono text-xs last:mb-0"
      {...props}
    />
  ),
  blockquote: ({ node: _node, ...props }) => (
    <blockquote
      className="mb-2 border-l-2 border-border pl-3 text-muted-foreground last:mb-0"
      {...props}
    />
  ),
  hr: ({ node: _node, ...props }) => (
    <hr className="my-3 border-border" {...props} />
  ),
};

// Custom badge for the `unverified-marker` node emitted by
// `rehypeUnverifiedMarkers`. Its tag is not a standard HTML element, so it
// is added with a cast; React never tries to render a literal
// `<unverified-marker>` because this override intercepts it first.
const UnverifiedMarker = ({ children }: { children?: React.ReactNode }) => (
  <span
    data-testid="unverified-marker"
    title="Entity emitted by the LLM but not present in the original event"
    className="inline-flex items-center rounded-full border border-rose-400 bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700"
  >
    {children}
  </span>
);

const COMPONENTS = {
  ...ELEMENT_COMPONENTS,
  "unverified-marker": UnverifiedMarker,
} as Components;

// Render a Markdown string as design-system elements with the
// `<<UNVERIFIED_*>>` badge treatment, WITHOUT the bordered card chrome.
// Shared by `AnalysisBody` and the per-unit sentence citations (#449), which
// stack several markdown chunks inside one card.
//
// When `citation` is supplied (a per-unit citation link), it is woven into
// the END of the unit's inline flow — appended inside the final paragraph so
// it renders inline directly after the sentence text rather than on its own
// line below the block (#449 review round 1). The node is supplied by a
// per-render component override closing over `citation`, so the rehype plugin
// only has to mark the insertion point.
export function AnalysisMarkdown({
  text,
  citation,
}: {
  text: string;
  citation?: React.ReactNode;
}) {
  const rehypePlugins = citation
    ? [rehypeUnverifiedMarkers, rehypeAppendCitationChip]
    : [rehypeUnverifiedMarkers];
  const components = citation
    ? ({ ...COMPONENTS, "citation-chip": () => <>{citation}</> } as Components)
    : COMPONENTS;
  return (
    <ReactMarkdown rehypePlugins={rehypePlugins} components={components}>
      {text}
    </ReactMarkdown>
  );
}

export function AnalysisBody({
  text,
  testid,
  emptyFallback,
}: {
  text: string;
  testid: string;
  // Rendered (verbatim, not as Markdown) when `text` is blank. Report
  // sections pass `"—"`; the event / story bodies leave it unset.
  emptyFallback?: string;
}) {
  const isEmpty = text.trim() === "";
  return (
    <div
      data-testid={testid}
      className="rounded border border-border bg-card px-4 py-3 text-sm text-foreground"
    >
      {isEmpty ? (emptyFallback ?? "") : <AnalysisMarkdown text={text} />}
    </div>
  );
}
