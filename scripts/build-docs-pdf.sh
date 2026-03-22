#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <en|ko>" >&2
  exit 1
fi

locale="$1"
python_bin="python3"
mkdocs_bin="mkdocs"

if [[ -x ".venv/bin/python" ]]; then
  python_bin=".venv/bin/python"
fi

if [[ -x ".venv/bin/mkdocs" ]]; then
  mkdocs_bin=".venv/bin/mkdocs"
fi

case "$locale" in
  en|ko) ;;
  *)
    echo "Unsupported locale: $locale" >&2
    exit 1
    ;;
esac

trap 'rm -f mkdocs.tmp.yml; if [[ "${AIMER_PDF_DEBUG:-0}" != "1" ]]; then rm -rf .pdf-tmp; fi' EXIT

AIMER_LOCALE="$locale" "$python_bin" - <<'PY'
import copy
import os
import sys
from datetime import datetime
import shutil
import yaml

locale = os.environ.get("AIMER_LOCALE")
if not locale:
    print("AIMER_LOCALE is required", file=sys.stderr)
    sys.exit(1)

with open("mkdocs.yml", "r", encoding="utf-8") as f:
    data = yaml.safe_load(f)

data = copy.deepcopy(data)
root = os.getcwd()

tmp_pdf_dir = os.path.join(root, ".pdf-tmp")
if os.path.exists(tmp_pdf_dir):
    shutil.rmtree(tmp_pdf_dir)
shutil.copytree(os.path.join(root, "docs", "pdf"), tmp_pdf_dir)

styles_path = os.path.join(tmp_pdf_dir, "styles.scss")
fonts_base = f'file://{os.path.join(tmp_pdf_dir, "fonts")}/'

with open(styles_path, "r", encoding="utf-8") as f:
    styles = f.read()

for prefix in ('../fonts/', 'pdf/fonts/', '/pdf/fonts/', 'fonts/'):
    styles = styles.replace(f'url("{prefix}', f'url("{fonts_base}')

with open(styles_path, "w", encoding="utf-8") as f:
    f.write(styles)

data["strict"] = False
data["site_dir"] = f"site-pdf-{locale}"

theme = data.get("theme")
if isinstance(theme, dict):
    theme["font"] = False

for plugin in data.get("plugins", []):
    if isinstance(plugin, dict) and "i18n" in plugin:
        plugin["i18n"]["build_only_locale"] = locale

now = datetime.now()

pdf_plugin = {
    "with-pdf": {
        "enabled_if_env": "AIMER_PDF_EXPORT",
        "output_path": os.path.join(root, "site", "pdf", f"aimer-web-manual.{locale}.pdf"),
        "custom_template_path": tmp_pdf_dir,
        "author": f"{now.strftime('%B %-d, %Y')}",
        "copyright": "\u00a9 2026 ClumL Inc.",
        "cover_logo": "docs/pdf/brand.svg",
    }
}

if locale == "ko":
    pdf_plugin["with-pdf"]["cover_title"] = "Aimer Web"
    pdf_plugin["with-pdf"]["cover_subtitle"] = "\uc0ac\uc6a9\uc790 \ub9e4\ub274\uc5bc"
    pdf_plugin["with-pdf"]["toc_title"] = "\ubaa9\ucc28"
    pdf_plugin["with-pdf"]["author"] = f"{now.strftime('%Y\ub144 %-m\uc6d4 %-d\uc77c')}"
    data.setdefault("extra", {})["cover_tagline"] = "\uc124\uce58 \ubc0f \uc0ac\uc6a9\uc790 \ub9e4\ub274\uc5bc"
else:
    pdf_plugin["with-pdf"]["cover_title"] = "Aimer Web"
    pdf_plugin["with-pdf"]["cover_subtitle"] = "User Manual"
    pdf_plugin["with-pdf"]["toc_title"] = "Table of Contents"
    data.setdefault("extra", {})["cover_tagline"] = "Installation and User Manual"

data.setdefault("plugins", []).append(pdf_plugin)

with open("mkdocs.tmp.yml", "w", encoding="utf-8") as f:
    yaml.safe_dump(data, f, sort_keys=False)
PY

AIMER_PDF_EXPORT=1 "$mkdocs_bin" build -f mkdocs.tmp.yml
