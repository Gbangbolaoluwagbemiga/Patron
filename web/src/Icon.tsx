// Icon.tsx — a small hand-picked line-icon set. Replaces emoji glyphs used as
// icons everywhere (📨🧠🔒⚔️💰...) — the single fastest way an interface reads as
// generated rather than designed. One stroke weight, one style, `currentColor`
// throughout so every icon inherits its context's color instead of carrying its
// own (emoji are always full-color, which is why they never sit quietly in a UI).
import type { ReactElement, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };
export type IconComponent = (props: IconProps) => ReactElement;

function base(props: IconProps) {
  const { size = 18, ...rest } = props;
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...rest,
  };
}

export function IconScroll(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M6 4h11a2 2 0 0 1 2 2v13a1 1 0 0 1-1.7.7L15 17H8a2 2 0 0 1-2-2V4Z" />
      <path d="M6 4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2" />
      <path d="M9 8h6M9 11h6" />
    </svg>
  );
}

export function IconBrain(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M9 4a2.5 2.5 0 0 0-2.5 2.5V7A2.5 2.5 0 0 0 4 9.5v1A2.5 2.5 0 0 0 6.5 13v1A3 3 0 0 0 9 17" />
      <path d="M15 4a2.5 2.5 0 0 1 2.5 2.5V7A2.5 2.5 0 0 1 20 9.5v1A2.5 2.5 0 0 1 17.5 13v1A3 3 0 0 1 15 17" />
      <path d="M9 4v13M15 4v13" />
      <path d="M9 20h6" />
    </svg>
  );
}

export function IconLock(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="4.5" y="11" width="15" height="9" rx="1.6" />
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
    </svg>
  );
}

export function IconSwords(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M5 5l6.5 6.5M5 5v4M5 5h4" />
      <path d="M19 5l-6.5 6.5M19 5v4M19 5h-4" />
      <path d="M5 19l4.5-4.5M19 19l-4.5-4.5" />
      <path d="M9 15l-4 4M15 15l4 4" />
    </svg>
  );
}

export function IconSearch(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M20 20l-4.8-4.8" />
    </svg>
  );
}

export function IconCoin(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v9M9.3 9.7c0-1.2 1.2-2.2 2.7-2.2s2.7.9 2.7 2c0 2.7-5.4 1.3-5.4 4 0 1.1 1.2 2 2.7 2s2.7-.9 2.7-2" />
    </svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.3 12.3l2.5 2.5 5-5.2" />
    </svg>
  );
}

export function IconAlert(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 3.5 21 19H3L12 3.5Z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="16.6" r="0.15" fill="currentColor" />
    </svg>
  );
}

export function IconFlag(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M6 4v16" />
      <path d="M6 5h9l-2 3.5L15 12H6" />
    </svg>
  );
}

export function IconShrug(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="7" r="2.6" />
      <path d="M5 19c0-3 2-6 3.5-6 .8 0 .8 2 1.5 2h4c.7 0 .7-2 1.5-2C17 13 19 16 19 19" />
    </svg>
  );
}

export function IconGavel(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M13.5 6.5 17.5 10.5" />
      <path d="M10 10l7 7" />
      <path d="M6.5 13.5l4-4 4 4-4 4z" />
      <path d="M4 20h6" />
      <path d="M15 6l3-3M18 9l3-3" />
    </svg>
  );
}

export function IconPen(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 20l1-4.2L15.6 5.2a1.5 1.5 0 0 1 2.1 0l1.1 1.1a1.5 1.5 0 0 1 0 2.1L8.2 19 4 20Z" />
      <path d="M13.5 7.2l3.3 3.3" />
    </svg>
  );
}

export function IconBolt(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M13 3 5 13.5h5.5L10 21l8.5-11H13l0-7Z" />
    </svg>
  );
}

export function IconMap(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M9 4 4 6v14l5-2 6 2 5-2V4l-5 2-6-2Z" />
      <path d="M9 4v14M15 6v14" />
    </svg>
  );
}

export function IconSplit(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M6 4v6c0 2 1.5 3 3.5 3H12" />
      <path d="M18 4v6c0 2-1.5 3-3.5 3H12" />
      <path d="M12 13v7" />
      <circle cx="6" cy="4" r="1.6" />
      <circle cx="18" cy="4" r="1.6" />
      <circle cx="12" cy="21.4" r="1.6" />
    </svg>
  );
}

export function IconDot(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="8.5" />
    </svg>
  );
}
