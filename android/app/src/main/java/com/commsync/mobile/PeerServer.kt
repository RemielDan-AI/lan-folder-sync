package com.commsync.mobile

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.InputStream
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest

/**
 * 手机端的对端服务。
 *
 * 为什么需要它：手机 App 原本只是客户端，电脑端无法列它的文件夹、也无法主动拉文件——
 * 只能手机推。要让两边对等，手机必须按同一套 HTTP 协议把自己 SAF 目录暴露出去。
 *
 * 只在 App 处于前台时运行（Android 后台限制），一次同步会话足够用。
 * 协议与桌面端完全一致：greet / folders / manifest / hashes / file(GET,PU) / delete / copy。
 */
class PeerServer(
    private val context: Context,
    private val deviceId: String,
    private val deviceName: String,
    private val token: String,
    private val preferredPort: Int = 47820,
    private val onLog: (String) -> Unit = {},
) {

    @Volatile
    private var tree: LocalTree? = null

    private var serverSocket: ServerSocket? = null
    private var acceptThread: Thread? = null
    private val treeLock = Any()

    @Volatile
    var runningPort: Int = 0
        private set

    fun updateTree(value: LocalTree?) {
        synchronized(treeLock) { tree = value }
    }

    private fun <T> withTree(block: (LocalTree) -> T): T? = synchronized(treeLock) {
        val current = tree ?: return null
        block(current)
    }

    /** 启动监听；端口被占用时顺延几次。返回实际端口，0 表示没起来 */
    fun start(): Int {
        if (serverSocket != null) return runningPort
        var port = preferredPort
        repeat(10) {
            try {
                val socket = ServerSocket(port)
                serverSocket = socket
                runningPort = port
                acceptThread = Thread({ acceptLoop(socket) }, "peer-server").also {
                    it.isDaemon = true
                    it.start()
                }
                onLog("本机服务已启动：端口 $port")
                return port
            } catch (e: Exception) {
                port++
            }
        }
        onLog("本机服务启动失败（端口都被占用）")
        return 0
    }

    fun stop() {
        acceptThread?.interrupt()
        acceptThread = null
        try {
            serverSocket?.close()
        } catch (e: Exception) {
            // 已经关了
        }
        serverSocket = null
        runningPort = 0
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (!socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (e: Exception) {
                return
            }
            Thread({ handle(client) }, "peer-conn").apply {
                isDaemon = true
                start()
            }
        }
    }

    /* ------------------------------------------------------------ 请求处理 */

    private fun handle(client: Socket) {
        try {
            client.soTimeout = 30_000
            val input = BufferedInputStream(client.getInputStream())
            val output = BufferedOutputStream(client.getOutputStream())

            val requestLine = readLine(input) ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return
            val method = parts[0].uppercase()
            val target = parts[1]

            val headers = HashMap<String, String>()
            while (true) {
                val line = readLine(input) ?: break
                if (line.isEmpty()) break
                val index = line.indexOf(':')
                if (index > 0) headers[line.substring(0, index).trim().lowercase()] = line.substring(index + 1).trim()
            }

            val uri = Uri.parse("http://localhost$target")
            val path = uri.path ?: ""

            // 只有 greet 不需要令牌；其余一律要配对时发给电脑的那枚令牌
            if (path != "/api/peer/greet") {
                val auth = headers["authorization"] ?: ""
                if (!auth.equals("Bearer $token", ignoreCase = true)) {
                    writeJson(output, 401, JSONObject().put("error", "需要配对令牌"))
                    return
                }
            }

            val contentLength = headers["content-length"]?.toLongOrNull() ?: 0L
            // 规定：POST 的 body 在路由前统一读一次，路由里只能解析、不许再读。
            // PUT 是文件流，交给对应分支自己消费。
            val bodyBytes = if (method == "POST" && contentLength > 0) {
                HttpBody.readExact(input, contentLength)
            } else {
                ByteArray(0)
            }

            when {
                path == "/api/peer/greet" && method == "GET" -> {
                    writeJson(
                        output, 200, JSONObject()
                            .put("app", "commsync")
                            .put("version", "android")
                            .put("id", deviceId)
                            .put("name", deviceName)
                            .put("port", runningPort)
                            .put("folderCount", if (tree != null) 1 else 0),
                    )
                }

                path == "/api/peer/folders" && method == "POST" -> {
                    val folders = JSONArray()
                    withTree { current ->
                        folders.put(
                            JSONObject()
                                .put("id", FOLDER_ID)
                                .put("name", current.label())
                                .put("path", "手机/${current.label()}"),
                        )
                    }
                    writeJson(output, 200, JSONObject().put("name", deviceName).put("folders", folders))
                }

                path == "/api/peer/manifest" && method == "POST" -> {
                    val folderId = HttpBody.jsonOf(bodyBytes).optString("folderId", FOLDER_ID)
                    val payload = withTree { current ->
                        val files = JSONObject()
                        for ((rel, stat) in current.scan()) {
                            files.put(
                                rel,
                                JSONObject()
                                    .put("size", stat.size)
                                    .put("mtimeMs", stat.mtimeMs)
                                    .put("sig", stat.sig),
                            )
                        }
                        JSONObject()
                            .put("root", "手机/${current.label()}")
                            .put("folder", JSONObject().put("id", folderId.ifBlank { FOLDER_ID }).put("name", current.label()))
                            .put("count", files.length())
                            .put("files", files)
                    }
                    writeJson(output, 200, payload ?: JSONObject().put("error", "手机上还没有选择文件夹"))
                }

                path == "/api/peer/hashes" && method == "POST" -> {
                    val request = HttpBody.jsonOf(bodyBytes)
                    val paths = request.optJSONArray("paths") ?: JSONArray()
                    val hashes = JSONObject()
                    withTree { current ->
                        for (index in 0 until paths.length()) {
                            val rel = paths.optString(index)
                            if (rel.isBlank()) continue
                            val hash = current.hash(rel)
                            if (hash == null) hashes.put(rel, JSONObject.NULL) else hashes.put(rel, hash)
                        }
                    }
                    writeJson(output, 200, JSONObject().put("hashes", hashes))
                }

                path == "/api/peer/file" && method == "GET" -> {
                    val rel = uri.getQueryParameter("path") ?: ""
                    val doc = withTree { current ->
                        if (current.doc(rel) == null) current.scan()
                        current.doc(rel)
                    }
                    if (doc == null) {
                        writeJson(output, 404, JSONObject().put("error", "文件不存在：$rel"))
                        return
                    }
                    output.write("HTTP/1.1 200 OK\r\n".toByteArray())
                    output.write("Content-Type: application/octet-stream\r\n".toByteArray())
                    output.write("Content-Length: ${doc.size}\r\n".toByteArray())
                    output.write("X-File-Mtime: ${doc.mtime}\r\n".toByteArray())
                    output.write("Connection: close\r\n\r\n".toByteArray())
                    withTree { current -> current.openInput(rel).use { it.copyTo(output, 64 * 1024) } }
                    output.flush()
                }

                path == "/api/peer/file" && method == "PUT" -> {
                    val rel = uri.getQueryParameter("path") ?: ""
                    if (tree == null) {
                        HttpBody.discard(input, contentLength)
                        writeJson(output, 400, JSONObject().put("error", "手机上还没有选择文件夹"))
                        return
                    }
                    val expected = headers["x-file-sha256"] ?: ""
                    val digest = MessageDigest.getInstance("SHA-256")
                    val limited = LimitedInputStream(input, contentLength)
                    val hashing = object : InputStream() {
                        override fun read(): Int {
                            val value = limited.read()
                            if (value >= 0) digest.update(value.toByte())
                            return value
                        }

                        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                            val read = limited.read(buffer, offset, length)
                            if (read > 0) digest.update(buffer, offset, read)
                            return read
                        }
                    }
                    val stat = withTree { current -> current.writeStream(rel, hashing) }
                    val actual = toHex(digest.digest())
                    if (expected.isNotEmpty() && expected != actual) {
                        withTree { current -> current.delete(rel) }
                        writeJson(output, 400, JSONObject().put("error", "校验失败：内容与发送方声明不一致"))
                        return
                    }
                    val size = stat?.size ?: 0
                    writeJson(
                        output, 200, JSONObject()
                            .put("ok", true)
                            .put("sha256", actual)
                            .put("size", size)
                            .put("mtimeMs", stat?.mtimeMs ?: System.currentTimeMillis())
                            .put("sig", stat?.sig ?: "$size:${System.currentTimeMillis()}"),
                    )
                }

                path == "/api/peer/delete" && method == "POST" -> {
                    val request = HttpBody.jsonOf(bodyBytes)
                    val paths = request.optJSONArray("paths") ?: JSONArray()
                    val deleted = JSONArray()
                    val failed = JSONArray()
                    withTree { current ->
                        current.scan()
                        for (index in 0 until paths.length()) {
                            val rel = paths.optString(index)
                            try {
                                current.delete(rel)
                                deleted.put(rel)
                            } catch (e: Exception) {
                                failed.put(JSONObject().put("path", rel).put("error", e.message ?: "删除失败"))
                            }
                        }
                    }
                    writeJson(output, 200, JSONObject().put("deleted", deleted).put("missing", JSONArray()).put("failed", failed))
                }

                path == "/api/peer/copy" && method == "POST" -> {
                    val request = HttpBody.jsonOf(bodyBytes)
                    val from = request.optString("from")
                    val to = request.optString("to")
                    val stat = withTree { current ->
                        if (current.doc(from) == null) current.scan()
                        current.copyWithin(from, to)
                    }
                    if (stat == null) {
                        writeJson(output, 400, JSONObject().put("error", "复制失败"))
                    } else {
                        writeJson(output, 200, JSONObject().put("ok", true).put("sig", stat.sig).put("size", stat.size))
                    }
                }

                else -> writeJson(output, 404, JSONObject().put("error", "接口不存在：$path"))
            }
            output.flush()
        } catch (e: Exception) {
            onLog("处理请求出错：${e.message}")
        } finally {
            try {
                client.close()
            } catch (e: Exception) {
                // 忽略
            }
        }
    }

    /* -------------------------------------------------------------- 工具 */

    private fun readLine(input: InputStream): String? {
        val builder = StringBuilder()
        while (true) {
            val value = input.read()
            if (value < 0) return if (builder.isEmpty()) null else builder.toString()
            if (value == '\n'.code) break
            if (value != '\r'.code) builder.append(value.toChar())
        }
        return builder.toString()
    }

    private fun writeJson(output: BufferedOutputStream, status: Int, body: JSONObject) {
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        val head = buildString {
            append("HTTP/1.1 ").append(status).append(' ').append(if (status == 200) "OK" else "Error").append("\r\n")
            append("Content-Type: application/json; charset=utf-8\r\n")
            append("Content-Length: ").append(bytes.size).append("\r\n")
            append("Connection: close\r\n\r\n")
        }
        output.write(head.toByteArray(Charsets.UTF_8))
        output.write(bytes)
    }

    companion object {
        const val FOLDER_ID = "local"

        private class LimitedInputStream(private val source: InputStream, private var remaining: Long) : InputStream() {
            override fun read(): Int {
                if (remaining <= 0) return -1
                val value = source.read()
                if (value >= 0) remaining--
                return value
            }

            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                if (remaining <= 0) return -1
                val toRead = minOf(length.toLong(), remaining).toInt()
                val read = source.read(buffer, offset, toRead)
                if (read > 0) remaining -= read
                return read
            }
        }
    }
}
