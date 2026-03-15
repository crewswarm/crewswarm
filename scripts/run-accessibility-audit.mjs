import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultTargetDir = path.join(repoRoot, "studio");
const reportPath = path.join(repoRoot, "accessibility_audit_report.md");

const TEXT_EXTENSIONS = new Set([".html", ".css", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".json"]);
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        files.push(...walk(fullPath));
      }
      continue;
    }
    if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files;
}

function readAuditFiles(targetDir) {
  return walk(targetDir).map((filePath) => ({
    path: filePath,
    content: fs.readFileSync(filePath, "utf8"),
  }));
}

function parseColor(input) {
  const value = input.trim().toLowerCase();

  if (/^#[\da-f]{3}$/i.test(value)) {
    return value
      .slice(1)
      .split("")
      .map((part) => Number.parseInt(part + part, 16));
  }

  if (/^#[\da-f]{6}$/i.test(value)) {
    return [
      Number.parseInt(value.slice(1, 3), 16),
      Number.parseInt(value.slice(3, 5), 16),
      Number.parseInt(value.slice(5, 7), 16),
    ];
  }

  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgbMatch) {
    return null;
  }

  const channels = rgbMatch[1]
    .split(",")
    .slice(0, 3)
    .map((part) => Number.parseFloat(part.trim()))
    .map((part) => Math.max(0, Math.min(255, part)));

  return channels.length === 3 && channels.every((part) => Number.isFinite(part)) ? channels : null;
}

function relativeLuminance(color) {
  const [r, g, b] = color
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground, background) {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg) {
    return null;
  }
  const lighter = Math.max(relativeLuminance(fg), relativeLuminance(bg));
  const darker = Math.min(relativeLuminance(fg), relativeLuminance(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

function extractFirstMatch(source, patterns) {
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function extractFontSize(source) {
  const match = source.match(/font-size\s*:\s*(\d+(?:\.\d+)?)px/i);
  return match ? Number.parseFloat(match[1]) : null;
}

function hasHeadingOrderGaps(levels) {
  let previous = null;
  for (const level of levels) {
    if (previous !== null && level - previous > 1) {
      return true;
    }
    previous = level;
  }
  return false;
}

function buildIssues(audit) {
  const issues = [];
  const { coverage, signals, notes } = audit;

  if (audit.scannedFiles === 0) {
    issues.push({
      severity: "high",
      title: "No source files were scanned",
      recommendation: "Point the CLI at a readable project directory with HTML, CSS, and JavaScript sources.",
    });
    return issues;
  }

  if (!signals.hasAriaLandmarks) {
    issues.push({
      severity: "high",
      title: "Semantic landmarks were not detected",
      recommendation: "Add `header`, `nav`, `main`, `aside`, or `footer` landmarks, or equivalent ARIA landmark roles, so screen reader users can navigate efficiently.",
    });
  }

  if (!signals.hasFormLabels) {
    issues.push({
      severity: "high",
      title: "Interactive controls appear under-labeled",
      recommendation: "Ensure every input, select, textarea, and button has a visible label or an accessible name via `aria-label` or `aria-labelledby`.",
    });
  }

  if (!signals.hasAltText) {
    issues.push({
      severity: "medium",
      title: "One or more images are missing alt text",
      recommendation: "Provide meaningful `alt` text for informative images and empty `alt=\"\"` for decorative assets.",
    });
  }

  if (!signals.headingOrderValid) {
    issues.push({
      severity: "medium",
      title: "Heading order has skipped levels",
      recommendation: "Keep headings sequential so assistive technology exposes a predictable outline.",
    });
  }

  if (!signals.linterEnabled) {
    issues.push({
      severity: "medium",
      title: "Accessibility linting was not detected",
      recommendation: "Add an automated checker such as axe, pa11y, or `eslint-plugin-jsx-a11y` to CI so regressions fail early.",
    });
  }

  if (typeof signals.fontSize === "number" && signals.fontSize < 16) {
    issues.push({
      severity: "medium",
      title: `Base font size is ${signals.fontSize}px`,
      recommendation: "Raise common body text to at least 16px where possible to improve readability and zoom resilience.",
    });
  }

  if (typeof signals.contrastRatio === "number" && signals.contrastRatio < 4.5) {
    issues.push({
      severity: "high",
      title: `Estimated color contrast is ${signals.contrastRatio.toFixed(2)}:1`,
      recommendation: "Adjust foreground and background colors to hit at least 4.5:1 for normal text and 3:1 for large text.",
    });
  }

  for (const note of notes) {
    issues.push({
      severity: "info",
      title: note,
      recommendation: "Review this signal manually and confirm whether it reflects a real user-facing problem.",
    });
  }

  if (issues.length === 0) {
    issues.push({
      severity: "info",
      title: "No major heuristic issues were detected",
      recommendation: "Follow up with manual keyboard and screen reader testing before treating this as a clean bill of health.",
    });
  }

  return issues;
}

function auditAccessibility(targetDir) {
  const files = readAuditFiles(targetDir);
  const combined = files.map((file) => file.content).join("\n");
  const markup = files
    .filter((file) => [".html", ".js", ".mjs", ".ts", ".tsx", ".jsx"].includes(path.extname(file.path).toLowerCase()))
    .map((file) => file.content)
    .join("\n");
  const styles = files
    .filter((file) => [".html", ".css"].includes(path.extname(file.path).toLowerCase()))
    .map((file) => file.content)
    .join("\n");

  const landmarkMatches = markup.match(/<(header|nav|main|aside|footer)\b|role=["'](?:banner|navigation|main|complementary|contentinfo)["']/gi) || [];
  const interactiveMatches = markup.match(/<(input|select|textarea|button)\b/gi) || [];
  const labeledMatches = markup.match(/<label\b[^>]*for=|aria-label=|aria-labelledby=/gi) || [];
  const imageMatches = markup.match(/<img\b/gi) || [];
  const imageAltMatches = markup.match(/<img\b[^>]*\balt=/gi) || [];
  const headings = [...markup.matchAll(/<h([1-6])\b/gi)].map((match) => Number.parseInt(match[1], 10));

  const foreground = extractFirstMatch(styles, [
    /--text(?:-1)?\s*:\s*([^;]+);/i,
    /\bcolor\s*:\s*(#[\da-f]{3,8}|rgba?\([^)]+\))/i,
  ]) || "#111111";
  const background = extractFirstMatch(styles, [
    /--bg(?:-card)?\s*:\s*([^;]+);/i,
    /\bbackground(?:-color)?\s*:\s*(#[\da-f]{3,8}|rgba?\([^)]+\))/i,
  ]) || "#ffffff";
  const fontSize = extractFontSize(styles) || 16;
  const linterEnabled = /jsx-a11y|eslint-plugin-jsx-a11y|axe|pa11y|lighthouse/i.test(combined);
  const headingOrderValid = headings.length > 0 ? !hasHeadingOrderGaps(headings) : true;
  const hasFormLabels = interactiveMatches.length === 0
    ? true
    : labeledMatches.length >= Math.max(1, Math.ceil(interactiveMatches.length * 0.6));
  const estimatedContrastRatio = contrastRatio(foreground, background);

  const notes = [];
  if (!landmarkMatches.length) {
    notes.push("No semantic landmarks or landmark roles were detected in the scanned files.");
  }
  if (interactiveMatches.length > labeledMatches.length) {
    notes.push(`Found ${interactiveMatches.length} interactive controls but only ${labeledMatches.length} explicit labels or accessible names.`);
  }
  if (imageMatches.length > imageAltMatches.length) {
    notes.push(`Found ${imageMatches.length} images and ${imageAltMatches.length} alt attributes in the scanned markup.`);
  }
  if (!headingOrderValid && headings.length) {
    notes.push(`Detected heading levels ${headings.join(", ")} with at least one skipped level.`);
  }
  if (!linterEnabled) {
    notes.push("No accessibility linter keywords were found in package or source configuration.");
  }

  return {
    projectDir: targetDir,
    scannedAt: new Date().toISOString(),
    scannedFiles: files.length,
    sampledFiles: files.slice(0, 10).map((file) => path.relative(targetDir, file.path)),
    signals: {
      foreground,
      background,
      contrastRatio: estimatedContrastRatio,
      fontSize,
      hasAriaLandmarks: landmarkMatches.length > 0,
      hasFormLabels,
      hasAltText: imageMatches.length === 0 || imageAltMatches.length === imageMatches.length,
      headingOrderValid,
      linterEnabled,
    },
    coverage: {
      landmarks: landmarkMatches.length,
      interactiveElements: interactiveMatches.length,
      labeledElements: labeledMatches.length,
      images: imageMatches.length,
      imagesWithAlt: imageAltMatches.length,
      headingsReviewed: headings.length,
    },
    notes,
  };
}

function formatIssue(issue) {
  return [
    `## ${issue.title}`,
    ``,
    `- Severity: ${issue.severity}`,
    `- Recommendation: ${issue.recommendation}`,
    ``,
  ].join("\n");
}

function writeReport(audit) {
  const issues = buildIssues(audit);
  const ratioText = typeof audit.signals.contrastRatio === "number"
    ? audit.signals.contrastRatio.toFixed(2)
    : "Unavailable";

  const markdown = [
    "# Accessibility Audit Report",
    "",
    `- Project: \`${path.relative(repoRoot, audit.projectDir) || "."}\``,
    `- Scanned at: ${audit.scannedAt}`,
    `- Files scanned: ${audit.scannedFiles}`,
    "",
    "## Summary",
    "",
    `- Estimated text contrast: ${ratioText}:1`,
    `- Base font size signal: ${audit.signals.fontSize}px`,
    `- Landmarks detected: ${audit.signals.hasAriaLandmarks ? "yes" : "no"}`,
    `- Form labeling looks sufficient: ${audit.signals.hasFormLabels ? "yes" : "no"}`,
    `- Images include alt text: ${audit.signals.hasAltText ? "yes" : "no"}`,
    `- Heading order is sequential: ${audit.signals.headingOrderValid ? "yes" : "no"}`,
    `- Accessibility linting detected: ${audit.signals.linterEnabled ? "yes" : "no"}`,
    "",
    "## Coverage",
    "",
    `- Landmark matches: ${audit.coverage.landmarks}`,
    `- Interactive elements: ${audit.coverage.interactiveElements}`,
    `- Labeled elements: ${audit.coverage.labeledElements}`,
    `- Images: ${audit.coverage.images}`,
    `- Images with alt text: ${audit.coverage.imagesWithAlt}`,
    `- Headings reviewed: ${audit.coverage.headingsReviewed}`,
    "",
    "## Sampled Files",
    "",
    ...audit.sampledFiles.map((file) => `- \`${file}\``),
    "",
    "## Issues And Recommendations",
    "",
    ...buildIssues(audit).flatMap((issue) => formatIssue(issue).split("\n")),
  ].join("\n");

  fs.writeFileSync(reportPath, `${markdown.trim()}\n`);
  return { issues, markdown };
}

function main() {
  const targetArg = process.argv[2];
  const targetDir = targetArg ? path.resolve(repoRoot, targetArg) : defaultTargetDir;

  if (!fs.existsSync(targetDir)) {
    console.error(`Target directory does not exist: ${targetDir}`);
    process.exit(1);
  }

  const audit = auditAccessibility(targetDir);
  const { issues } = writeReport(audit);

  console.log(`Accessibility audit complete for ${targetDir}`);
  console.log(`Report written to ${reportPath}`);
  console.log(`Issues reported: ${issues.length}`);
}

main();
