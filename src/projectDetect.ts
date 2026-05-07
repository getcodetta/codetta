// Project framework detection — given a flat list of workspace-relative
// paths, return the set of frameworks present and a curated list of
// privacy-sensitive globs each one wants excluded from AI uploads.
//
// Used by Settings → AI privacy to one-click-add framework-specific
// patterns on top of the universal defaults (.env, .ssh, .aws, …).
// The defaults catch the obvious leaks; this catches the
// framework-specific ones that vary per stack:
//   - Laravel writes secrets into storage/framework/cache/data/**.
//   - WordPress's wp-config.php is the canonical "do not leak this"
//     file, but its name is not in the default list.
//   - Rails ships an encrypted credentials.yml.enc whose key (master.key)
//     is the actual secret — leaking the key compromises everything.
//   - Django often has a hand-edited local_settings.py that overrides
//     production secrets locally.
//
// Detection is intentionally cheap: we look at the FIRST few hundred
// paths the file walker returns. False positives are fine — the user
// reviews suggestions before applying them.

export interface DetectedFramework {
  /** Stable id used as the React key + suggestion-source label. */
  id: string;
  /** Human-readable label shown in the UI. */
  label: string;
  /** Privacy-glob patterns (forward-slash, **-aware) that the user
   *  can one-click add to their exclusion list. Patterns that are
   *  already covered by the default list should be omitted. */
  patterns: string[];
}

interface FrameworkSpec {
  id: string;
  label: string;
  /** A path is a marker if any of these regexes matches it (forward
   *  slash form, no leading separator). Detection ORs across markers. */
  markers: RegExp[];
  patterns: string[];
}

const SPECS: FrameworkSpec[] = [
  {
    id: "wordpress",
    label: "WordPress",
    markers: [
      /^wp-config\.php$/,
      /^wp-config-sample\.php$/,
      /^wp-content\/(themes|plugins|uploads)\//,
      /^wp-includes\/version\.php$/,
    ],
    patterns: [
      "**/wp-config.php",
      "**/wp-content/uploads/**",
      "**/wp-content/debug.log",
      "**/wp-content/uploads/cache/**",
      "**/wp-content/backup-db/**",
    ],
  },
  {
    id: "laravel",
    label: "Laravel",
    markers: [
      /^artisan$/,
      /^bootstrap\/app\.php$/,
      /^config\/(app|database|auth|mail|services)\.php$/,
    ],
    patterns: [
      "**/storage/app/private/**",
      "**/storage/framework/cache/**",
      "**/storage/framework/sessions/**",
      "**/storage/logs/**",
      "**/bootstrap/cache/**",
    ],
  },
  {
    id: "rails",
    label: "Ruby on Rails",
    markers: [
      /^config\/application\.rb$/,
      /^config\/routes\.rb$/,
      /^bin\/rails$/,
    ],
    patterns: [
      "**/config/master.key",
      "**/config/credentials/**.key",
      "**/config/credentials.yml.enc",
      "**/db/*.sqlite3",
      "**/db/*.sqlite3-journal",
      "**/log/**",
      "**/tmp/cache/**",
    ],
  },
  {
    id: "django",
    label: "Django",
    markers: [/^manage\.py$/, /^[^/]+\/(settings|wsgi|asgi)\.py$/],
    patterns: [
      "**/local_settings.py",
      "**/db.sqlite3",
      "**/db.sqlite3-journal",
      "**/staticfiles/**",
      "**/media/private/**",
    ],
  },
  {
    id: "nextjs",
    label: "Next.js",
    markers: [/^next\.config\.(js|ts|mjs|cjs)$/, /^pages\/_app\.(jsx?|tsx?)$/],
    patterns: ["**/.next/**", "**/.vercel/**"],
  },
  {
    id: "nuxt",
    label: "Nuxt",
    markers: [/^nuxt\.config\.(js|ts|mjs)$/],
    patterns: ["**/.nuxt/**", "**/.output/**"],
  },
  {
    id: "sveltekit",
    label: "SvelteKit",
    markers: [/^svelte\.config\.(js|ts)$/],
    patterns: ["**/.svelte-kit/**"],
  },
  {
    id: "rust",
    label: "Rust",
    markers: [/^Cargo\.toml$/, /^Cargo\.lock$/],
    patterns: ["**/target/**"],
  },
  {
    id: "tauri",
    label: "Tauri",
    markers: [/^src-tauri\/Cargo\.toml$/, /^src-tauri\/tauri\.conf\.json$/],
    patterns: ["**/src-tauri/target/**", "**/src-tauri/gen/**"],
  },
  {
    id: "ios",
    label: "iOS / Xcode",
    markers: [/\.xcodeproj\//, /\.xcworkspace\//],
    patterns: [
      "**/*.xcuserstate",
      "**/Pods/**",
      "**/DerivedData/**",
      "**/*.mobileprovision",
      "**/*.p12",
    ],
  },
  {
    id: "android",
    label: "Android / Gradle",
    markers: [/^build\.gradle(\.kts)?$/, /^app\/build\.gradle(\.kts)?$/],
    patterns: [
      "**/gradle.properties",
      "**/keystore.properties",
      "**/*.jks",
      "**/*.keystore",
      "**/local.properties",
    ],
  },
];

/**
 * Detect frameworks present in the given file list. Returns at most one
 * entry per framework id, ordered as the SPECS array. Patterns that are
 * already in `existingPatterns` are filtered out so the UI can show
 * "nothing new to suggest" cleanly.
 */
export function detectFrameworks(
  paths: string[],
  existingPatterns: readonly string[] = [],
): DetectedFramework[] {
  // Normalize once: strip Windows backslashes + leading "./", lowercase
  // is NOT applied because most marker files are case-significant on
  // case-sensitive filesystems (and on Windows the FS is case-insensitive
  // either way).
  const norm = paths.map((p) =>
    p.replace(/\\/g, "/").replace(/^\.\//, ""),
  );
  const exclude = new Set(existingPatterns);
  const out: DetectedFramework[] = [];
  for (const spec of SPECS) {
    const hit = norm.some((p) => spec.markers.some((re) => re.test(p)));
    if (!hit) continue;
    const patterns = spec.patterns.filter((p) => !exclude.has(p));
    if (patterns.length === 0) continue;
    out.push({ id: spec.id, label: spec.label, patterns });
  }
  return out;
}
