#!/usr/bin/env bash
# Rebuilds vendor/kendo-ui-core/kendo.vsr.min.js — a subset of Kendo UI Core (Apache-2.0)
# containing only the widgets this app uses. Run from the repo root:  bash scripts/build-kendo.sh
# Needs Node/npm. Bump KENDO_VERSION to upgrade (keep the theme version in index.html in step).
set -euo pipefail
KENDO_VERSION="${KENDO_VERSION:-2026.3.812}"
OUT="vendor/kendo-ui-core"
TMP="$(mktemp -d)"
( cd "$TMP" && npm pack --silent "kendo-ui-core@${KENDO_VERSION}" >/dev/null 2>&1 && tar xzf kendo-ui-core-*.tgz )
SRC="$TMP/package/umd"

# Dependency-ordered module list (TextBox, TextArea, TimePicker, NumericTextBox, DropDownList,
# Button, ButtonGroup, Dialog, Notification, ListView, Pager, Loader + their dependencies).
MODS="kendo.core kendo.floatinglabel kendo.html.base kendo.html.icon kendo.icons kendo.textbox kendo.textarea
kendo.userevents kendo.selectable kendo.calendar kendo.popup kendo.label kendo.dateinput kendo.html.button
kendo.timepicker kendo.numerictextbox kendo.data.odata kendo.data.xml kendo.data kendo.badge kendo.button
kendo.actionsheet.view kendo.actionsheet kendo.list kendo.fx kendo.draganddrop kendo.mobile.scroller
kendo.virtuallist kendo.dropdownlist kendo.togglebutton kendo.buttongroup kendo.dialog kendo.notification
kendo.toggleinputbase kendo.html.input kendo.checkbox kendo.datepicker kendo.validator kendo.binder
kendo.editable kendo.pager kendo.listview kendo.loader"

mkdir -p "$OUT"
{
  echo "/*! Kendo UI Core ${KENDO_VERSION} (Apache-2.0) — subset bundle for PTP VSR. Built by scripts/build-kendo.sh */"
  for m in $MODS; do
    # Each UMD module is wrapped with a local 'exports' object: several 2026 UMD files reference
    # 'exports' even in their browser-global branch, which throws when loaded via <script>.
    echo "(function(exports){"
    sed 's|//# sourceMappingURL=.*||' "$SRC/$m.min.js"
    echo "}).call(window,{});"
  done
} > "$OUT/kendo.vsr.min.js"
cp "$TMP/package/LICENSE" "$OUT/LICENSE"
rm -rf "$TMP"
echo "Built $OUT/kendo.vsr.min.js ($(wc -c < "$OUT/kendo.vsr.min.js") bytes)"
