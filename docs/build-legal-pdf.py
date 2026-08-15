#!/usr/bin/env python3
"""Render a legal Markdown doc to print-ready HTML for PDF export.

Usage: python3 build-legal-pdf.py <source.md> <output.html> [Title]
"""
import re
import sys
import markdown
from pathlib import Path

src = Path(sys.argv[1])
out_html = Path(sys.argv[2])
title = sys.argv[3] if len(sys.argv) > 3 else src.stem

body = markdown.markdown(
    src.read_text(encoding="utf-8"),
    extensions=["tables", "sane_lists", "attr_list"],
)

# Rewrite sibling document links (e.g. Terms → "privacy-policy.md") to the .html
# rendition, so the cross-references resolve when these are served side by side.
body = re.sub(r'(href="[^"]+)\.md"', r'\1.html"', body)

html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  @page {{ size: Letter; margin: 22mm 20mm; }}
  /* Pin a light document regardless of the reader's OS/browser dark mode: the
     text colour is dark, so without an explicit light canvas these render
     dark-on-dark when served in a dark-themed browser. */
  html {{ -webkit-print-color-adjust: exact; print-color-adjust: exact;
          color-scheme: light; background: #ffffff; }}
  body {{
    font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
    font-size: 10.5pt; line-height: 1.5; color: #1a1a1a; margin: 0;
  }}
  h1 {{ font-size: 22pt; margin: 0 0 4px; color: #0b1f3a; }}
  h2 {{ font-size: 13pt; margin: 22px 0 6px; color: #0b1f3a;
        border-bottom: 1.5px solid #d9dee6; padding-bottom: 4px; }}
  h3 {{ font-size: 11.5pt; margin: 16px 0 4px; color: #0b1f3a; }}
  p {{ margin: 6px 0; }}
  strong {{ color: #0b1f3a; }}
  ul, ol {{ margin: 6px 0 6px 0; padding-left: 20px; }}
  li {{ margin: 3px 0; }}
  a {{ color: #1a56db; word-break: break-word; }}
  hr {{ border: none; border-top: 1px solid #e5e8ee; margin: 18px 0; }}
  blockquote {{
    margin: 12px 0; padding: 10px 14px; background: #f5f7fa;
    border-left: 3px solid #1a56db; border-radius: 4px; color: #33415c;
  }}
  blockquote p {{ margin: 4px 0; }}
  table {{ border-collapse: collapse; width: 100%; margin: 10px 0;
           font-size: 9.5pt; }}
  th, td {{ border: 1px solid #cdd3dd; padding: 7px 9px; text-align: left;
            vertical-align: top; }}
  th {{ background: #0b1f3a; color: #fff; font-weight: 600; }}
  tr:nth-child(even) td {{ background: #f7f9fc; }}
  h2, h3, table, blockquote {{ page-break-inside: avoid; }}
  /* Screen-only: the print layout leans on @page margins, so on a screen the
     text would otherwise run edge to edge. Centre it in a readable column. */
  @media screen {{
    body {{ max-width: 46rem; margin: 0 auto; padding: 40px 24px 64px; }}
  }}
</style>
</head>
<body>
{body}
</body>
</html>
"""

out_html.write_text(html, encoding="utf-8")
print(f"wrote {out_html}")
