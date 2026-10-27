package com.commsync.mobile

/**
 * 扫描与执行。
 * 扫描：本地清单 + 对端清单 + 基线 → 差异计划（只在需要时才算哈希，避免每次全量读盘）
 * 执行：按计划上传/下载/删除，逐项回写基线；每个文件都做 SHA-256 校验
 */
class SyncEngine(
    private val client: RemoteClient,
    private val tree: LocalTree,
    private val store: Store,
    private val baselineKey: String,
) {

    data class Plan(
        val entries: MutableList<Entry>,
        val remoteRoot: String,
        val remoteFolderName: String,
        val localCount: Int,
        val remoteCount: Int,
    )

    data class ApplyResult(val ok: Int, val failed: Int, val bytes: Long)

    fun scan(remoteFolderId: String, log: (String) -> Unit): Plan {
        log("扫描本地目录…")
        val local = tree.scan { count -> if (count % 200 == 0) log("  已读取 $count 个文件") }
        log("本地 ${local.size} 个文件，读取对端清单…")
        val manifest = client.manifest(remoteFolderId)
        log("对端 ${manifest.files.size} 个文件")

        val base = store.loadBaseline(baselineKey)
        val entries = quickPlan(local, manifest.files, base).toMutableList()

        val needLocal = entries.filter { it.needLocalHash }.map { it.path }
        val needRemote = entries.filter { it.needRemoteHash }.map { it.path }
        if (needLocal.isNotEmpty() || needRemote.isNotEmpty()) {
            log("校验内容：本地 ${needLocal.size} 个，对端 ${needRemote.size} 个")
        }

        val localHashes = HashMap<String, String?>()
        for (path in needLocal) localHashes[path] = tree.hash(path)

        val remoteHashes = if (needRemote.isEmpty()) HashMap() else HashMap(client.hashes(remoteFolderId, needRemote))

        resolvePlan(entries, localHashes, remoteHashes)
        return Plan(entries, manifest.root, manifest.folderName, local.size, manifest.files.size)
    }

    fun apply(
        remoteFolderId: String,
        entries: List<Entry>,
        allowDeletes: Boolean,
        log: (String) -> Unit,
    ): ApplyResult {
        val base = store.loadBaseline(baselineKey)
        val now = System.currentTimeMillis()
        var ok = 0
        var failed = 0
        var bytes = 0L

        val operations = ArrayList<Pair<Entry, Op>>()
        for (entry in entries) {
            for (op in expandOps(entry, allowDeletes, now)) operations.add(entry to op)
        }
        log("开始执行 ${operations.size} 个操作")

        var index = 0
        for ((entry, op) in operations) {
            index++
            try {
                when (op.type) {
                    "upload" -> {
                        val hash = entry.localHash ?: tree.hash(op.from)
                            ?: throw RemoteException("无法读取本地文件：${op.from}")
                        val stat = entry.local ?: FileStat(0, now)
                        val sig = client.upload(remoteFolderId, op.to, tree.openInput(op.from), stat.size, stat.mtimeMs, hash)
                        base[op.to] = BaseEntry(hash, hash, stat.sig, sig.ifBlank { null })
                        bytes += stat.size
                        log("↑ $index/${operations.size} ${op.from} → ${formatBytes(stat.size)}")
                    }
                    "download" -> {
                        var expected = if (op.from == entry.path) entry.remoteHash else null
                        if (expected == null) {
                            expected = client.hashes(remoteFolderId, listOf(op.from))[op.from]
                        }
                        val (conn, stream) = client.openDownload(remoteFolderId, op.from)
                        stream.use { tree.writeStream(op.to, it) }
                        conn.disconnect()

                        val written = tree.doc(op.to)
                        val actualHash = tree.hash(op.to)
                        if (expected != null && actualHash != null && expected != actualHash) {
                            throw RemoteException("校验失败：${op.to} 内容与预期不一致")
                        }
                        val localStat = written?.let { FileStat(it.size, it.mtime) } ?: FileStat(0, now)
                        val remoteSig = if (op.from == entry.path) entry.remote?.sig else null
                        base[op.to] = BaseEntry(actualHash ?: expected, expected, localStat.sig, remoteSig)
                        bytes += localStat.size
                        log("↓ $index/${operations.size} ${op.from} → ${formatBytes(localStat.size)}")
                    }
                    "delete-local" -> {
                        tree.delete(op.from)
                        base.remove(op.from)
                        log("× 已删除本地：${op.from}")
                    }
                    "delete-remote" -> {
                        client.delete(remoteFolderId, listOf(op.from))
                        base.remove(op.from)
                        log("× 已删除远端：${op.from}")
                    }
                    "copy-remote" -> {
                        client.copy(remoteFolderId, op.from, op.to)
                        log("· 远端另存：${op.to}")
                    }
                    else -> throw RemoteException("未知操作 ${op.type}")
                }
                ok++
            } catch (e: Exception) {
                failed++
                log("× ${entry.path}：${e.message ?: "失败"}")
            }
        }

        store.saveBaseline(baselineKey, base)
        return ApplyResult(ok, failed, bytes)
    }
}
