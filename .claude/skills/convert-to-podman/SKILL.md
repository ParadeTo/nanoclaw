---
name: convert-to-podman
description: Switch from Docker to Podman as the container runtime. Uses podman-mac-helper (macOS) or podman-docker (Linux) so the existing `docker` CLI calls work transparently — no source code changes required. Use when the user wants to use Podman instead of Docker Desktop. Triggers on "convert to podman", "use podman", "switch to podman", "install podman".
---

# Convert to Podman

This skill configures NanoClaw to run containers via Podman instead of Docker. It works by making Podman respond to `docker` commands — so **no source code changes are needed**.

- **macOS**: installs Podman, starts a Podman machine (Linux VM), and installs `podman-mac-helper` so `/var/run/docker.sock` routes to Podman.
- **Linux**: installs `podman` + `podman-docker` and starts the Podman socket.

## Phase 1: Pre-flight

### Detect platform

```bash
uname -s
```

- `Darwin` → macOS path
- `Linux` → Linux path

### Check if already working

```bash
docker info 2>&1 | grep -i podman && echo "ALREADY_PODMAN" || echo "NOT_YET"
```

If `ALREADY_PODMAN`: skip to Phase 3 (verify).

---

## Phase 2: Install (macOS)

### 2a. Install Podman

```bash
which podman && podman --version || brew install podman
```

### 2b. Initialize Podman machine

Check if a machine already exists:

```bash
podman machine list
```

If no machine exists, initialize one:

```bash
podman machine init
```

If a machine exists but is stopped, skip init.

### 2c. Start Podman machine

```bash
podman machine start
```

If it's already running, this is a no-op.

### 2d. Install podman-mac-helper

The helper installs a launchd service that creates a symlink from `/var/run/docker.sock` to the Podman socket, so any tool calling `docker` transparently uses Podman.

```bash
sudo podman-mac-helper install
```

If you see `already installed`, skip to 2e.

### 2e. Restart Podman machine to activate the helper

```bash
podman machine stop
podman machine start
```

### 2f. Verify docker socket works

```bash
docker info 2>&1 | head -5
```

Expected: output mentions Podman. If `docker info` still fails, set `DOCKER_HOST` explicitly:

```bash
export DOCKER_HOST="unix://$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"
docker info 2>&1 | head -5
```

If this fixes it, persist `DOCKER_HOST` in `.env`:

```bash
SOCKET=$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')
grep -q 'DOCKER_HOST' .env 2>/dev/null || echo "DOCKER_HOST=unix://$SOCKET" >> .env
```

---

## Phase 2: Install (Linux)

### 2a. Install podman and podman-docker

Detect package manager and install:

```bash
# Debian/Ubuntu
sudo apt-get install -y podman podman-docker

# Fedora/RHEL/CentOS
sudo dnf install -y podman podman-docker

# Arch
sudo pacman -S --noconfirm podman podman-docker
```

`podman-docker` provides a `docker` shim that delegates all commands to `podman`.

### 2b. Start and enable the Podman socket

Rootless (preferred):

```bash
systemctl --user start podman.socket
systemctl --user enable podman.socket
```

Verify the socket is active:

```bash
systemctl --user status podman.socket
```

### 2c. Verify docker socket works

```bash
docker info 2>&1 | head -5
```

If `docker info` fails with a socket error, set `DOCKER_HOST`:

```bash
export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/podman/podman.sock"
docker info 2>&1 | head -5
```

If this fixes it, persist in `.env`:

```bash
grep -q 'DOCKER_HOST' .env 2>/dev/null || echo "DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock" >> .env
```

---

## Phase 3: Verify

### Build the NanoClaw container image

```bash
./container/build.sh
```

If the build fails with a cache issue:

```bash
docker builder prune -f
./container/build.sh
```

### Test basic execution

```bash
echo '{}' | docker run -i --rm --entrypoint /bin/echo nanoclaw-agent:latest "Podman OK"
```

Expected output: `Podman OK`

### Test readonly mounts

```bash
mkdir -p /tmp/test-ro && echo "test" > /tmp/test-ro/file.txt
docker run --rm --entrypoint /bin/bash \
  -v /tmp/test-ro:/test:ro \
  nanoclaw-agent:latest \
  -c "cat /test/file.txt && touch /test/new.txt 2>&1 || echo 'Write blocked (expected)'"
rm -rf /tmp/test-ro
```

Expected: read succeeds, write fails.

---

## Troubleshooting

**`docker info` shows "Cannot connect to the Docker daemon"**

macOS: Check Podman machine is running:
```bash
podman machine list
podman machine start
```

Linux: Check socket:
```bash
systemctl --user status podman.socket
systemctl --user start podman.socket
```

**`podman-mac-helper` not found (macOS)**

It ships with Podman — check the Cellar path:
```bash
ls $(brew --prefix)/Cellar/podman/*/bin/podman-mac-helper
```

If found, run it with the full path:
```bash
sudo $(brew --prefix)/Cellar/podman/$(podman --version | awk '{print $3}')/bin/podman-mac-helper install
```

**Build fails: `host-gateway` not supported**

Older versions of Podman (< 4.1) don't support `host-gateway`. Upgrade:
```bash
brew upgrade podman        # macOS
sudo apt-get upgrade podman  # Linux
```

**Rootful mode needed (macOS)**

Some images require root inside the VM:
```bash
podman machine stop
podman machine set --rootful
podman machine start
```
