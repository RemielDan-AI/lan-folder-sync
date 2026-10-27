package com.commsync.mobile

/**
 * 差异引擎 —— 与桌面版 shared/diff.js 同一套判定规则：
 * 签名（大小+修改时间）快速筛出"可能变过"的文件，再由哈希确认内容，最后区分
 * 新增 / 修改 / 删除 / 冲突。冲突一律不替用户决定，交给界面上的按钮。
 */

data class FileStat(val size: Long, val mtimeMs: Long) {
    val sig: String get() = "$size:$mtimeMs"
}

data class BaseEntry(
    val hash: String? = null,
    val remoteHash: String? = null,
    val localSig: String? = null,
    val remoteSig: String? = null,
)

enum class Kind {
    SAME, NEW_LOCAL, NEW_REMOTE, MODIFIED_LOCAL, MODIFIED_REMOTE,
    DELETED_LOCAL, DELETED_REMOTE, BOTH_DELETED,
    CONFLICT_ADD, CONFLICT_MODIFY, CONFLICT_DELETE_MODIFY;

    val isConflict: Boolean
        get() = this == CONFLICT_ADD || this == CONFLICT_MODIFY || this == CONFLICT_DELETE_MODIFY

    val label: String
        get() = when (this) {
            SAME -> "一致"
            NEW_LOCAL -> "本地新增"
            NEW_REMOTE -> "远端新增"
            MODIFIED_LOCAL -> "本地已修改"
            MODIFIED_REMOTE -> "远端已修改"
            DELETED_LOCAL -> "本地已删除"
            DELETED_REMOTE -> "远端已删除"
            BOTH_DELETED -> "两端已删除"
            CONFLICT_ADD -> "两端都有且不同"
            CONFLICT_MODIFY -> "两端都改过"
            CONFLICT_DELETE_MODIFY -> "一边删除一边修改"
        }
}

enum class Action { UPLOAD, DOWNLOAD, DELETE_LOCAL, DELETE_REMOTE, KEEP_BOTH, NONE }

class Entry(
    val path: String,
    var kind: Kind,
    var action: Action = Action.NONE,
    val local: FileStat? = null,
    val remote: FileStat? = null,
    val base: BaseEntry? = null,
    var survivor: String? = null,
    var localHash: String? = null,
    var remoteHash: String? = null,
    var needLocalHash: Boolean = false,
    var needRemoteHash: Boolean = false,
    var pendingReason: String? = null,
    var note: String = "",
) {
    val settled: Boolean
        get() = !kind.isConflict || action != Action.NONE
}

/** 原子操作：执行层只认这个结构 */
data class Op(val type: String, val from: String, val to: String)

data class Summary(
    val total: Int,
    val same: Int,
    val upload: Int,
    val download: Int,
    val deletes: Int,
    val conflicts: Int,
    val pendingConflicts: Int,
    val bytesUp: Long,
    val bytesDown: Long,
)

/** 第一阶段：只看签名就能定的先定，定不下来的标记需要哪边的哈希 */
fun quickPlan(
    local: Map<String, FileStat>,
    remote: Map<String, FileStat>,
    base: Map<String, BaseEntry>,
): List<Entry> {
    val paths = (local.keys + remote.keys + base.keys).toSortedSet()
    return paths.map { path ->
        val l = local[path]
        val r = remote[path]
        val b = base[path]
        when {
            l != null && r != null -> {
                if (b == null) {
                    if (l.sig == r.sig) {
                        Entry(path, Kind.SAME, Action.NONE, l, r, b, needLocalHash = true, pendingReason = "sig-equal")
                    } else {
                        Entry(path, Kind.SAME, Action.NONE, l, r, b, needLocalHash = true, needRemoteHash = true, pendingReason = "first-meet", note = "首次同步，需要比对内容")
                    }
                } else {
                    val lChanged = l.sig != b.localSig
                    val rChanged = r.sig != b.remoteSig
                    when {
                        !lChanged && !rChanged -> Entry(path, Kind.SAME, Action.NONE, l, r, b)
                        !lChanged -> Entry(path, Kind.SAME, Action.NONE, l, r, b, needRemoteHash = true, pendingReason = "remote-touch")
                        !rChanged -> Entry(path, Kind.SAME, Action.NONE, l, r, b, needLocalHash = true, pendingReason = "local-touch")
                        else -> Entry(path, Kind.SAME, Action.NONE, l, r, b, needLocalHash = true, needRemoteHash = true, pendingReason = "both-touch")
                    }
                }
            }
            l != null -> {
                if (b == null) {
                    Entry(path, Kind.NEW_LOCAL, Action.UPLOAD, l, null, null, note = "仅本地有")
                } else if (l.sig == b.localSig) {
                    Entry(path, Kind.DELETED_REMOTE, Action.DELETE_LOCAL, l, null, b, note = "远端已删除，本地未改")
                } else {
                    Entry(path, Kind.CONFLICT_DELETE_MODIFY, Action.NONE, l, null, b, survivor = "local", needLocalHash = true, pendingReason = "remote-gone-local-changed")
                }
            }
            r != null -> {
                if (b == null) {
                    Entry(path, Kind.NEW_REMOTE, Action.DOWNLOAD, null, r, null, note = "仅远端有")
                } else if (r.sig == b.remoteSig) {
                    Entry(path, Kind.DELETED_LOCAL, Action.DELETE_REMOTE, null, r, b, note = "本地已删除，远端未改")
                } else {
                    Entry(path, Kind.CONFLICT_DELETE_MODIFY, Action.NONE, null, r, b, survivor = "remote", needRemoteHash = true, pendingReason = "local-gone-remote-changed")
                }
            }
            else -> Entry(path, Kind.BOTH_DELETED, Action.NONE, null, null, b, note = "两端都已删除")
        }
    }
}

/** 第二阶段：用哈希把待定条目落到最终结论 */
fun resolvePlan(
    entries: List<Entry>,
    localHashes: Map<String, String?>,
    remoteHashes: Map<String, String?>,
): List<Entry> {
    for (entry in entries) {
        val reason = entry.pendingReason ?: continue
        val lh = localHashes[entry.path] ?: entry.localHash
        val rh = remoteHashes[entry.path] ?: entry.remoteHash
        entry.localHash = lh
        entry.remoteHash = rh
        val baseHash = entry.base?.hash
        val baseRemoteHash = entry.base?.remoteHash ?: baseHash
        entry.pendingReason = null
        entry.needLocalHash = false
        entry.needRemoteHash = false

        when (reason) {
            "sig-equal" -> { entry.kind = Kind.SAME; entry.action = Action.NONE; entry.note = "两端一致" }
            "first-meet" -> {
                if (lh != null && lh == rh) {
                    entry.kind = Kind.SAME; entry.action = Action.NONE; entry.note = "内容一致"
                } else {
                    entry.kind = Kind.CONFLICT_ADD; entry.action = Action.NONE; entry.note = "两端都有，内容不同"
                }
            }
            "local-touch" -> {
                if (lh != null && lh == baseHash) {
                    entry.kind = Kind.SAME; entry.action = Action.NONE; entry.note = "仅时间戳变化"
                } else {
                    entry.kind = Kind.MODIFIED_LOCAL; entry.action = Action.UPLOAD; entry.note = "本地已修改"
                }
            }
            "remote-touch" -> {
                if (rh != null && rh == baseRemoteHash) {
                    entry.kind = Kind.SAME; entry.action = Action.NONE; entry.note = "仅时间戳变化"
                } else {
                    entry.kind = Kind.MODIFIED_REMOTE; entry.action = Action.DOWNLOAD; entry.note = "远端已修改"
                }
            }
            "both-touch" -> when {
                lh != null && lh == rh -> { entry.kind = Kind.SAME; entry.action = Action.NONE; entry.note = "两端改成同一内容" }
                lh != null && lh == baseHash && rh != null && rh == baseRemoteHash -> {
                    entry.kind = Kind.SAME; entry.action = Action.NONE; entry.note = "签名抖动，内容未变"
                }
                lh != null && lh == baseHash -> { entry.kind = Kind.MODIFIED_REMOTE; entry.action = Action.DOWNLOAD; entry.note = "仅远端修改" }
                rh != null && rh == baseRemoteHash -> { entry.kind = Kind.MODIFIED_LOCAL; entry.action = Action.UPLOAD; entry.note = "仅本地修改" }
                else -> { entry.kind = Kind.CONFLICT_MODIFY; entry.action = Action.NONE; entry.note = "两端都修改且内容不同" }
            }
            "remote-gone-local-changed" -> {
                if (lh != null && lh == baseHash) {
                    entry.kind = Kind.DELETED_REMOTE; entry.action = Action.DELETE_LOCAL; entry.note = "远端已删除，本地未改"
                } else {
                    entry.kind = Kind.CONFLICT_DELETE_MODIFY; entry.action = Action.NONE; entry.note = "远端删除，本地有改动"
                }
            }
            "local-gone-remote-changed" -> {
                if (rh != null && rh == baseRemoteHash) {
                    entry.kind = Kind.DELETED_LOCAL; entry.action = Action.DELETE_REMOTE; entry.note = "本地已删除，远端未改"
                } else {
                    entry.kind = Kind.CONFLICT_DELETE_MODIFY; entry.action = Action.NONE; entry.note = "本地删除，远端有改动"
                }
            }
        }
    }
    return entries
}

/** 使用者对冲突的选择。keep-local 表示"以本地这一侧的状态为准"（本地没有=接受删除） */
fun applyChoice(entry: Entry, choice: String) {
    entry.action = when (choice) {
        "skip" -> Action.NONE
        "keep-local" -> if (entry.local != null) Action.UPLOAD else if (entry.remote != null) Action.DELETE_REMOTE else Action.NONE
        "keep-remote" -> if (entry.remote != null) Action.DOWNLOAD else if (entry.local != null) Action.DELETE_LOCAL else Action.NONE
        "keep-both" -> if (entry.kind == Kind.CONFLICT_DELETE_MODIFY) Action.NONE else Action.KEEP_BOTH
        else -> entry.action
    }
}

fun summarize(entries: List<Entry>): Summary {
    var same = 0
    var upload = 0
    var download = 0
    var deletes = 0
    var conflicts = 0
    var pending = 0
    var bytesUp = 0L
    var bytesDown = 0L
    for (entry in entries) {
        if (entry.kind == Kind.SAME || entry.kind == Kind.BOTH_DELETED) { same++; continue }
        if (entry.kind.isConflict) {
            conflicts++
            if (entry.action == Action.NONE) pending++
        }
        when (entry.action) {
            Action.UPLOAD -> { upload++; bytesUp += entry.local?.size ?: 0L }
            Action.DOWNLOAD -> { download++; bytesDown += entry.remote?.size ?: 0L }
            Action.DELETE_LOCAL, Action.DELETE_REMOTE -> deletes++
            Action.KEEP_BOTH -> { upload++; download++ }
            Action.NONE -> Unit
        }
    }
    return Summary(entries.size, same, upload, download, deletes, conflicts, pending, bytesUp, bytesDown)
}

fun conflictCopyName(path: String, tag: String, nowMillis: Long): String {
    val stamp = formatStamp(nowMillis)
    val slash = path.lastIndexOf('/')
    val dir = if (slash >= 0) path.substring(0, slash + 1) else ""
    val name = if (slash >= 0) path.substring(slash + 1) else path
    val dot = name.lastIndexOf('.')
    val stem = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot) else ""
    return "$dir$stem ($tag $stamp)$ext"
}

/** 把条目展开成原子操作（执行层只认这个） */
fun expandOps(entry: Entry, allowDeletes: Boolean, nowMillis: Long): List<Op> {
    val action = entry.action
    if (action == Action.NONE) return emptyList()
    if ((action == Action.DELETE_LOCAL || action == Action.DELETE_REMOTE) && !allowDeletes) return emptyList()
    return when (action) {
        Action.UPLOAD -> listOf(Op("upload", entry.path, entry.path))
        Action.DOWNLOAD -> listOf(Op("download", entry.path, entry.path))
        Action.DELETE_LOCAL -> listOf(Op("delete-local", entry.path, entry.path))
        Action.DELETE_REMOTE -> listOf(Op("delete-remote", entry.path, entry.path))
        Action.KEEP_BOTH -> {
            val copy = conflictCopyName(entry.path, "远端副本", nowMillis)
            listOf(
                Op("copy-remote", entry.path, copy),
                Op("upload", entry.path, entry.path),
                Op("download", copy, copy),
            )
        }
        Action.NONE -> emptyList()
    }
}
