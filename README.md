# VSCode VMware Controller

在 VS Code 中直接管理本地 VMware 虚拟机——无需切换到 VMware Workstation 窗口即可完成启动、挂起、关机等操作。

> English version: [README.en.md](./README.en.md)

---

## 功能概览

- 在 VS Code 侧边栏中**列出并监控**所有 VMware 虚拟机
- 支持右键菜单操作：启动/恢复、挂起、软/硬关机、软/硬重置
- 自动扫描指定目录下的 `.vmx` 文件发现虚拟机
- **近实时状态刷新**：定时轮询 + 操作后立即刷新 + 文件变更监听
- **快速配置向导**：点击 ⚙ 即可设置 vmrun 路径、扫描目录、刷新间隔

侧边栏效果：

```
VMware
└─ Virtual Machines        ↻   ⚙
   ├─ Ubuntu Dev           running
   ├─ Windows 11           suspended
   └─ Kali Lab             stopped
```

---

## 实现原理

### 核心依赖

插件通过调用 VMware 自带的 `vmrun.exe` 命令行工具来控制虚拟机，不依赖任何第三方 SDK。

### 虚拟机发现

采用两种方式组合：

| 方式 | 说明 |
|---|---|
| **手动配置** | 用户在 `settings.json` 中通过 `vmware.vms` 指定虚拟机名称和 `.vmx` 路径 |
| **目录扫描** | 插件递归扫描 `vmware.scanRoots` 配置的目录，自动发现 `.vmx` 文件 |

两者结果合并去重，手动配置的虚拟机优先。

### 状态判断

| 状态 | 判断依据 |
|---|---|
| Running | `vmrun list` 返回的路径中包含该 `.vmx` 文件 |
| Suspended | `.vmx` 同目录下存在 `.vmss`（挂起状态文件） |
| Stopped | 既不在 `vmrun list` 中，也无 `.vmss` 文件 |
| Missing | `.vmx` 文件不存在 |

### 实时刷新

采用三层刷新机制保证状态近实时：

1. **定时轮询**：默认每 3 秒执行 `vmrun list` + 文件状态检测
2. **操作后刷新**：每次执行启动/挂起/关机/重置后立即刷新
3. **文件监听**：通过 VS Code `FileSystemWatcher` 监听扫描目录下 `.vmx` / `.vmss` 的增删改

### 命令映射

所有操作均通过 `vmrun` 子命令实现：

| 操作 | vmrun 命令 |
|---|---|
| 启动/恢复 | `vmrun start xxx.vmx nogui` |
| 挂起 | `vmrun suspend xxx.vmx` |
| 软关机 | `vmrun stop xxx.vmx soft` |
| 硬关机 | `vmrun stop xxx.vmx hard` |
| 软重置 | `vmrun reset xxx.vmx soft` |
| 硬重置 | `vmrun reset xxx.vmx hard` |

> 使用 `nogui` 参数可避免弹出 VMware Workstation 窗口。

---

## 配置

打开 VS Code 设置（`settings.json`），添加以下配置：

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

也可以点击侧边栏顶部的 **⚙ 配置按钮**，通过图形向导进行配置。

### 配置项说明

| 配置项 | 说明 | 默认值 |
|---|---|---|
| `vmware.vmrunPath` | `vmrun.exe` 的完整路径 | `"vmrun"` |
| `vmware.scanRoots` | 需要扫描 `.vmx` 文件的目录列表 | `[]` |
| `vmware.vms` | 手动指定的虚拟机（名称 + 路径） | `[]` |
| `vmware.refreshIntervalMs` | 状态刷新间隔（毫秒），最小 1000 | `3000` |
| `vmware.maxScanDepth` | 扫描目录的最大递归深度 | `5` |

---

## 许可

MIT
