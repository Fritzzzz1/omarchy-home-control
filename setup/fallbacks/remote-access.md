# Remote access fallback: Tailscale

Used when the user has no existing private network/tailnet path to this machine, and a phone is
in play. Free for this personal use — a private mesh VPN, not a public tunnel.

Tell the user plainly, before installing anything: this requires a Tailscale account —
`tailscale up` opens the sign-in flow. Free for personal use, but it's a real account, not just
a package install.

## Install

**Arch/Omarchy**: `tailscale` is in the official `extra` repo — `sudo pacman -S tailscale`, no
AUR helper needed.

**Any other distro**: no equivalent guarantee — research the actual install path there.

## Sign in and serve

    sudo systemctl enable --now tailscaled
    sudo tailscale up          # opens a browser link to authenticate

Once signed in, map the voice server onto the tailnet over HTTPS:

    tailscale serve --bg --https <port> http://127.0.0.1:<VOICE_PORT>

`tailscale status --json` reports the MagicDNS name (`.Self.DNSName`) to build the real phone
URL from. Never enable Funnel — that exposes to the public internet, which this must not do by
default.
