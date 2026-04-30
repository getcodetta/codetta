import logoUrl from "../assets/app-logo.png";

interface AIIconProps {
  size?: number;
  className?: string;
  title?: string;
  /** When false, render the bare app logo without the AI accent. */
  sparkle?: boolean;
}

/**
 * Single source of truth for the AI brand mark used across the app
 * (activity bar, AI chat tabs, side panel header, "New AI chat" buttons).
 *
 * Renders the app logo with a small "AI sparkle" badge tucked into the
 * top-right corner, so the AI affordances stay visually anchored to the
 * product brand. To rebrand the app icon itself, replace
 * `src/assets/app-logo.png`. To restyle the sparkle badge, edit the
 * inline SVG below.
 */
export function AIIcon({
  size = 16,
  className,
  title,
  sparkle = true,
}: AIIconProps) {
  const sparkleSize = Math.max(8, Math.round(size * 0.55));
  return (
    <span
      className={className}
      style={{
        position: "relative",
        display: "inline-flex",
        width: size,
        height: size,
        flexShrink: 0,
      }}
      aria-label={title ?? (sparkle ? "AI" : "App")}
      role="img"
    >
      <img
        src={logoUrl}
        width={size}
        height={size}
        alt=""
        draggable={false}
        style={{ display: "block", objectFit: "contain" }}
      />
      {sparkle && (
        <svg
          width={sparkleSize}
          height={sparkleSize}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{
            position: "absolute",
            top: -Math.round(sparkleSize * 0.15),
            right: -Math.round(sparkleSize * 0.15),
            filter: "drop-shadow(0 0 1px rgba(0,0,0,0.35))",
          }}
          aria-hidden="true"
        >
          {/* Four-pointed sparkle = the universal "AI" accent */}
          <path
            d="M12 1.5L14 9L21.5 11L14 13L12 20.5L10 13L2.5 11L10 9L12 1.5Z"
            fill="#F5B524"
            stroke="#ffffff"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );
}
