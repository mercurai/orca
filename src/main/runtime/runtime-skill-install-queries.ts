import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { detectInstalledAgentsWithShellPathHydration } from '../preflight/agent-detection'
import { listManagedSkillInstalls } from '../skills/skill-install-provenance'
import { WslSkillInstallFilesystem } from '../skills/skill-wsl-install-filesystem'
import { nativeSkillInstallFilesystem } from '../skills/skill-install-filesystem'
import {
  previewSkillInstallOnSshHost,
  removeSkillInstallOnSshHost
} from '../skills/skill-ssh-relay-service'
import { previewSkillBundleInstallOnSshHost } from '../skills/skill-bundle-ssh-relay-service'
import {
  previewSharedSkillBundleInstall,
  previewSharedSkillInstall,
  removeSharedSkillInstall
} from '../skills/skill-install-management-service'
import { toLinuxPath } from '../wsl'
import type {
  SkillBundleInstallPreviewRequest,
  SkillInstallPreviewRequest,
  SkillInstallRequest,
  SkillRemoveRequest,
  ManagedSkillInstall,
  SkillUploadBeginRequest,
  SkillUploadChunkRequest
} from './runtime-skill-types'
import { RuntimeSkillInstallCommands } from './runtime-skill-install-commands'
import { normalizeSshRelaySkillDestination } from '../skills/skill-ssh-relay-destination'

export class RuntimeSkillInstallQueries extends RuntimeSkillInstallCommands {
  async previewSharedSkillInstallRequest(request: SkillInstallPreviewRequest) {
    const target = await this.sshTarget(request.destination)
    if (target) {
      return previewSkillInstallOnSshHost({
        provider: target.provider,
        request: {
          ...request,
          destination: normalizeSshRelaySkillDestination(request.destination)
        },
        workspace: target.workspace
      })
    }
    await this.host.skillTransactionRecovery
    return previewSharedSkillInstall(request, {
      authority: this.authority(),
      stateDirectory: this.userDataPath(),
      detectProviders: detectInstalledAgentsWithShellPathHydration,
      resolveProviderRootOverrides: (destination) => this.roots(destination)
    })
  }
  async previewSharedSkillBundleInstallRequest(request: SkillBundleInstallPreviewRequest) {
    const target = await this.sshTarget(request.destination)
    if (target) {
      return previewSkillBundleInstallOnSshHost({
        provider: target.provider,
        request: {
          ...request,
          destination: normalizeSshRelaySkillDestination(request.destination)
        },
        workspace: target.workspace
      })
    }
    await this.host.skillTransactionRecovery
    return previewSharedSkillBundleInstall(request, {
      authority: this.authority(),
      stateDirectory: this.userDataPath(),
      detectProviders: detectInstalledAgentsWithShellPathHydration,
      resolveProviderRootOverrides: (destination) => this.roots(destination)
    })
  }
  async removeSharedSkillInstallRequest(request: SkillRemoveRequest) {
    const target = await this.sshTarget(request.destination)
    if (target) {
      return removeSkillInstallOnSshHost({
        provider: target.provider,
        request: {
          ...request,
          destination: normalizeSshRelaySkillDestination(request.destination)
        },
        workspace: target.workspace
      })
    }
    await this.host.skillTransactionRecovery
    return removeSharedSkillInstall(request, {
      authority: this.authority(),
      stateDirectory: this.userDataPath(),
      detectProviders: detectInstalledAgentsWithShellPathHydration,
      resolveProviderRootOverrides: (destination) => this.roots(destination)
    })
  }
  async listManagedSkillInstalls(connectionId?: string): Promise<ManagedSkillInstall[]> {
    if (connectionId) {
      return this.requireSsh(connectionId)
    }
    await this.host.skillTransactionRecovery
    const runtimeId = this.host.getRuntimeId()
    // Why Promise.all: the receipt walk and the worktree resolve are independent, and the
    // resolve can take a full scan round-trip on an SSH fleet.
    const [installs, worktrees] = await Promise.all([
      listManagedSkillInstalls(join(this.userDataPath(), 'skill-installs'), {
        observeReceipt: async (receipt) =>
          receipt.wslDistro
            ? new WslSkillInstallFilesystem(receipt.wslDistro, [
                dirname(receipt.canonicalPath)
              ]).observeSkill(receipt.canonicalPath, receipt.fileModes)
            : nativeSkillInstallFilesystem.observeSkill(receipt.canonicalPath, receipt.fileModes)
      }),
      this.host.listResolvedWorktrees()
    ])
    const folders = this.host.listFolderWorkspaces()
    return installs.flatMap((install): ManagedSkillInstall[] => {
      if (install.scope === 'global') {
        return [
          {
            ...install,
            destination: install.destinationIdentity.startsWith(`global:${runtimeId}:wsl:`)
              ? {
                  scope: 'global' as const,
                  executionTarget: {
                    kind: 'wsl' as const,
                    distro: install.destinationIdentity.slice(`global:${runtimeId}:wsl:`.length)
                  }
                }
              : { scope: 'global' as const }
          }
        ]
      }
      const worktree = worktrees.find(
        (candidate) => install.destinationIdentity === `workspace:${runtimeId}:${candidate.id}`
      )
      const folder = folders.find(
        (candidate) => install.destinationIdentity === `workspace:${runtimeId}:${candidate.id}`
      )
      return worktree
        ? [{ ...install, destination: { scope: 'workspace' as const, worktreeId: worktree.id } }]
        : folder
          ? [
              {
                ...install,
                destination: { scope: 'workspace' as const, folderWorkspaceId: folder.id }
              }
            ]
          : []
    })
  }
  async skillInstallDestinationUsesSsh(destination: SkillInstallRequest['destination']) {
    return Boolean(await this.sshTarget(destination))
  }
  async resolveSkillDiscoveryProviderRoots(target: {
    kind: 'native-host' | 'wsl'
    distro?: string
  }) {
    const roots = await this.roots({
      scope: 'global',
      homeDirectory: homedir(),
      ...(target.kind === 'wsl' && target.distro ? { wslDistro: target.distro } : {})
    })
    return target.kind === 'wsl'
      ? Object.fromEntries(
          Object.entries(roots).map(([provider, root]) => [provider, toLinuxPath(root)])
        )
      : roots
  }
  beginSkillUpload(request: SkillUploadBeginRequest) {
    return this.requireUploads().begin(request)
  }
  appendSkillUploadChunk(request: SkillUploadChunkRequest) {
    return this.requireUploads().append(request)
  }
  commitSkillUpload(uploadId: string) {
    return this.requireUploads().commit(uploadId)
  }
  cancelSkillUpload(uploadId: string) {
    return this.requireUploads().cancel(uploadId)
  }
}
