// Home Control bar widget.
//
// Deliberately read-mostly. The one thing this widget will never do is stop or
// restart the voice channel: the `claude` process talking to whoever is on the
// phone is a child of that service, so a stray click on the bar would cut off a
// live conversation. Starting a service that is down is safe, so that is offered;
// stopping is left to `home-control-ctl`, which asks first.

import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "omarchy.home-control"

  // Settings arrive as the shell.json layout entry minus its id, so the manifest
  // defaults are not merged in for us — they have to be restated here.
  readonly property string unit: String(setting("unit", "home-control.service"))
  readonly property int refreshIntervalSec: Math.min(600, Math.max(2,
      parseInt(String(setting("refreshIntervalSec", 10)), 10) || 10))
  readonly property bool showLabel: setting("showLabel", false) === true

  // "active" | "inactive" | "failed" | "activating" | "unknown" | "missing"
  property string unitState: "unknown"
  property bool reachable: false
  property string phoneUrl: ""

  readonly property bool up: unitState === "active"
  readonly property bool broken: unitState === "failed"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  readonly property color fg: bar ? bar.barForeground : Color.foreground
  readonly property color iconColor: broken ? (bar ? bar.urgent : Color.urgent)
                                            : (up ? fg : Qt.darker(fg, 1.55))

  // --- status -----------------------------------------------------------------
  // home-control-ctl is the single source of truth about how Home Control is wired on
  // this machine; the widget deliberately knows nothing about ports or hostnames.
  Process {
    id: probe
    running: false
    command: []
    stdout: StdioCollector { id: probeOut; waitForEnd: true }
    onExited: function (exitCode) {
      if (exitCode !== 0) {
        // 127 and friends: the control command is not installed yet.
        root.unitState = "missing"
        root.reachable = false
        return
      }
      try {
        var s = JSON.parse(String(probeOut.text || "{}"))
        root.unitState = String(s.state || "unknown")
        root.reachable = s.reachable === true
        root.phoneUrl = String(s.url || "")
      } catch (e) {
        root.unitState = "unknown"
      }
    }
  }

  function refresh() {
    if (probe.running)
      return
    probe.command = ["home-control-ctl", "status", "--json"]
    probe.running = true
  }

  Timer {
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  // Re-read shortly after an action so the icon does not sit stale for a full poll.
  Timer {
    id: settle
    interval: 900
    repeat: false
    onTriggered: root.refresh()
  }

  // A process left running past its usefulness is a process to reap.
  Timer {
    interval: 15000
    repeat: true
    running: true
    onTriggered: if (probe.running) probe.running = false
  }

  onSettingsChanged: refresh()

  // --- actions ------------------------------------------------------------------
  function openPhoneUrl() {
    if (!phoneUrl)
      return
    Quickshell.execDetached(["xdg-open", phoneUrl])
  }

  function startIfDown() {
    if (up || unitState === "missing")
      return
    Quickshell.execDetached(["systemctl", "--user", "start", unit])
    settle.restart()
  }

  readonly property string tooltip: {
    if (unitState === "missing")
      return "Home Control is not installed on this machine\n(run the plugin's install.sh)"
    if (up)
      return "Home Control is up" + (reachable ? "" : " but not answering on localhost")
          + (phoneUrl ? "\n" + phoneUrl : "") + "\nClick to open · right-click does nothing while it is up"
    if (broken)
      return "Home Control failed — home-control-ctl logs\nRight-click to start it"
    return "Home Control is " + unitState + "\nRight-click to start it"
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // Nerd Font microphone.
    text: root.showLabel ? "\uf130  Home Control" : "\uf130"
    slotSize: Style.bar.statusSlot
    fontSize: Style.font.caption
    foreground: root.iconColor
    tooltipText: root.tooltip

    onPressed: function (buttonCode) {
      if (buttonCode === Qt.RightButton)
        root.startIfDown()
      else if (buttonCode === Qt.MiddleButton)
        root.refresh()
      else
        root.openPhoneUrl()
    }
  }
}
