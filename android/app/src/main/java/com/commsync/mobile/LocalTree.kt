package com.commsync.mobile

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.webkit.MimeTypeMap
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest

/**
 * 通过 SAF 读写用户选中的目录。
 * 这是原生应用能"选整个文件夹"的关键：ACTION_OPEN_DOCUMENT_TREE 拿到的授权可以持久保存，
 * 之后就能递归遍历、读写里面的文件——网页里的 webkitdirectory 永远做不到这一点。
 */
class LocalTree(private val context: Context, val treeUri: Uri) {

    companion object {
        const val MIME_DIR = DocumentsContract.Document.MIME_TYPE_DIR
        private const val MAX_DEPTH = 32
    }

    data class Doc(val rel: String, val docId: String, val isDir: Boolean, val size: Long, val mtime: Long)

    private val resolver get() = context.contentResolver
    private val rootDocId: String = DocumentsContract.getTreeDocumentId(treeUri)
    private val index = HashMap<String, Doc>()          // rel -> 文件
    private val dirIds = HashMap<String, String>()      // rel 目录 -> docId（"" 表示根）

    init {
        dirIds[""] = rootDocId
    }

    fun label(): String {
        val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, rootDocId)
        return queryName(docUri) ?: "已选择目录"
    }

    private fun queryName(docUri: Uri): String? = try {
        resolver.query(docUri, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
            ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
    } catch (e: Exception) {
        null
    }

    private fun children(dirDocId: String): List<Triple<String, String, Boolean>> {
        val uri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, dirDocId)
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
        )
        val out = ArrayList<Triple<String, String, Boolean>>()
        try {
            resolver.query(uri, projection, null, null, null)?.use { cursor ->
                while (cursor.moveToNext()) {
                    val docId = cursor.getString(0) ?: continue
                    val name = cursor.getString(1) ?: continue
                    val mime = cursor.getString(2) ?: ""
                    out.add(Triple(docId, name, mime == MIME_DIR))
                }
            }
        } catch (e: Exception) {
            // 某个子目录读不了就跳过，不中断整次扫描
        }
        return out
    }

    /** 递归扫描，返回 rel -> 文件状态 */
    fun scan(onProgress: (Int) -> Unit = {}): Map<String, FileStat> {
        index.clear()
        dirIds.clear()
        dirIds[""] = rootDocId
        val files = HashMap<String, FileStat>()

        fun visit(dirDocId: String, prefix: String, depth: Int) {
            if (depth > MAX_DEPTH) return
            for ((childId, name, isDir) in children(dirDocId)) {
                val rel = if (prefix.isEmpty()) name else "$prefix/$name"
                if (isDir) {
                    dirIds[rel] = childId
                    visit(childId, rel, depth + 1)
                } else {
                    val stat = statOf(childId) ?: FileStat(0, 0)
                    index[rel] = Doc(rel, childId, false, stat.size, stat.mtimeMs)
                    files[rel] = stat
                    if (files.size % 50 == 0) onProgress(files.size)
                }
            }
        }

        visit(rootDocId, "", 0)
        onProgress(files.size)
        return files
    }

    private fun statOf(docId: String): FileStat? = try {
        val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)
        resolver.query(
            docUri,
            arrayOf(DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED),
            null, null, null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) {
                val size = if (cursor.isNull(0)) 0L else cursor.getLong(0)
                val mtime = if (cursor.isNull(1)) 0L else cursor.getLong(1)
                FileStat(size, mtime)
            } else null
        }
    } catch (e: Exception) {
        null
    }

    fun doc(rel: String): Doc? = index[rel]

    fun openInput(rel: String): InputStream {
        val doc = index[rel] ?: throw RemoteException("本地文件不存在：$rel")
        val uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, doc.docId)
        return resolver.openInputStream(uri) ?: throw RemoteException("无法读取：$rel")
    }

    fun hash(rel: String): String? = try {
        val digest = MessageDigest.getInstance("SHA-256")
        openInput(rel).use { stream ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = stream.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        toHex(digest.digest())
    } catch (e: Exception) {
        null
    }

    private fun parentDocId(dirRel: String): String {
        dirIds[dirRel]?.let { return it }
        val slash = dirRel.lastIndexOf('/')
        val parentRel = if (slash >= 0) dirRel.substring(0, slash) else ""
        val name = if (slash >= 0) dirRel.substring(slash + 1) else dirRel
        val parentId = parentDocId(parentRel)
        val existing = children(parentId).firstOrNull { it.second == name && it.third }
        val docId = if (existing != null) {
            existing.first
        } else {
            val parentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, parentId)
            val created = DocumentsContract.createDocument(resolver, parentUri, MIME_DIR, name)
                ?: throw RemoteException("无法创建目录：$dirRel")
            DocumentsContract.getDocumentId(created)
        }
        dirIds[dirRel] = docId
        return docId
    }

    private fun mimeOf(name: String): String {
        val dot = name.lastIndexOf('.')
        if (dot < 0 || dot == name.length - 1) return "application/octet-stream"
        val ext = name.substring(dot + 1).lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
    }

    private fun childUri(dirRel: String, name: String, create: Boolean): Uri? {
        val dirId = parentDocId(dirRel)
        val existing = children(dirId).firstOrNull { it.second == name && !it.third }
        if (existing != null) {
            return DocumentsContract.buildDocumentUriUsingTree(treeUri, existing.first)
        }
        if (!create) return null
        val dirUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, dirId)
        return DocumentsContract.createDocument(resolver, dirUri, mimeOf(name), name)
    }

    /** 写入（新建或覆盖）一个文件，返回落盘后的状态 */
    fun writeStream(rel: String, input: InputStream): FileStat {
        val slash = rel.lastIndexOf('/')
        val dirRel = if (slash >= 0) rel.substring(0, slash) else ""
        val name = if (slash >= 0) rel.substring(slash + 1) else rel

        val uri = childUri(dirRel, name, create = true) ?: throw RemoteException("无法创建文件：$rel")
        // openOutputStream 在部分系统上可能返回 null，这里显式兜住
        val sink = resolver.openOutputStream(uri, "wt") ?: throw RemoteException("无法写入：$rel")
        sink.use { out ->
            input.use { source -> source.copyTo(out, 64 * 1024) }
        }
        val docId = DocumentsContract.getDocumentId(uri)
        val stat = statOf(docId) ?: FileStat(0, System.currentTimeMillis())
        index[rel] = Doc(rel, docId, false, stat.size, stat.mtimeMs)
        return stat
    }

    /** 目录内复制（冲突"都留"时用） */
    fun copyWithin(fromRel: String, toRel: String): FileStat {
        val input = openInput(fromRel)
        return writeStream(toRel, input)
    }

    fun delete(rel: String) {
        val doc = index[rel] ?: return
        val uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, doc.docId)
        DocumentsContract.deleteDocument(resolver, uri)
        index.remove(rel)
    }

    fun exists(rel: String): Boolean = index.containsKey(rel)
}
