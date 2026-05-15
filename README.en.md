# VSCode VMware Controller

Manage local VMware virtual machines directly from VS Code — start, suspend, stop, and reset VMs without leaving the editor.

> 中文版本: [README.md](./README.md)

---

## Features

- List and monitor VMware VMs in the VS Code sidebar
- Right-click context menu: Start/Resume, Suspend, Soft/Hard Stop, Soft/Hard Reset
- Auto-discover VMs by scanning configured directories for `.vmx` files
- Near real-time status updates via polling, post-operation refresh, and file watchers
- Quick configuration wizard via ⚙ button

Sidebar preview:

```
VMware
└─ Virtual Machines        ↻   ⚙
   ├─ Ubuntu Dev           running
   ├─ Windows 11           suspended
   └─ Kali Lab             stopped
```

---

## How It Works

### Core Dependency

The extension uses VMware's built-in `vmrun.exe` CLI tool. No third-party SDK required.

### VM Discovery

| Method | Description |
|---|---|
| **Manual config** | Specify VM name and `.vmx` path via `vmware.vms` in settings |
| **Directory scan** | Recursively scan `vmware.scanRoots` for `.vmx` files |

Results are merged and deduplicated, with manually configured VMs taking priority.

### State Detection

| State | Detection |
|---|---|
| Running | `.vmx` path appears in `vmrun list` output |
| Suspended | `.vmss` file exists alongside the `.vmx` |
| Stopped | Neither in `vmrun list` nor has `.vmss` |
| Missing | `.vmx` file does not exist |

### Refresh Mechanism

Three layers:

1. **Polling** — runs `vmrun list` + file checks every 3 seconds by default
2. **Post-operation** — immediately refreshes after any VM action
3. **File watcher** — monitors `.vmx` / `.vmss` file changes via VS Code `FileSystemWatcher`

### Command Mapping

| Action | vmrun Command |
|---|---|
| Start/Resume | `vmrun start xxx.vmx nogui` |
| Suspend | `vmrun suspend xxx.vmx` |
| Soft Stop | `vmrun stop xxx.vmx soft` |
| Hard Stop | `vmrun stop xxx.vmx hard` |
| Soft Reset | `vmrun reset xxx.vmx soft` |
| Hard Reset | `vmrun reset xxx.vmx hard` |

> The `nogui` flag prevents the VMware Workstation window from appearing.

---

## Configuration

Add to VS Code `settings.json`:

```json
{
  "vmware.vmrunPath": "E:\\VMware\\vmrun.exe",
  "vmware.scanRoots": [
    "F:\\Virtual"
  ],
  "vmware.vms": [
    {
      "name": "Ubuntu Dev",
      "path": "F:\\Virtual\\Ubuntu\\Ubuntu.vmx"
    }
  ],
  "vmware.refreshIntervalMs": 3000,
  "vmware.maxScanDepth": 5
}
```

Or use the ⚙ configuration wizard in the sidebar.

### Settings Reference

| Setting | Description | Default |
|---|---|---|
| `vmware.vmrunPath` | Full path to `vmrun.exe` | `"vmrun"` |
| `vmware.scanRoots` | Directories to scan for `.vmx` files | `[]` |
| `vmware.vms` | Manually configured VMs (name + path) | `[]` |
| `vmware.refreshIntervalMs` | Refresh interval in ms (min 1000) | `3000` |
| `vmware.maxScanDepth` | Max recursion depth for scanning | `5` |

---

## License

MIT
