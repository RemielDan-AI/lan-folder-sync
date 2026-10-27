package com.commsync.mobile

import android.net.Uri
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * 对端 HTTP 客户端。协议和桌面版完全一致：
 * 配对 → 列文件夹 → 取清单 → 按需取哈希 → 上传/下载/删除/复制。
 */
class RemoteException(message: String) : Exception(message)

class RemoteClient(var baseUrl: String, var token: String? = null) {

    data class RemoteFolder(val id: String, val name: String, val path: String)
    data class PairResult(val token: String, val hostId: String, val hostName: String)
    data class Manifest(val root: String, val folderName: String, val files: Map<String, FileStat>)
    data class Greet(val name: String, val version: String, val folderCount: Int)

    private fun url(path: String): URL = URL(baseUrl.trimEnd('/') + path)

    private fun connect(path: String, method: String): HttpURLConnection {
        val conn = url(path).openConnection() as HttpURLConnection
        conn.requestMethod = method
        // 局域网里连接失败要"快"，不然用户会以为点击没反应
        conn.connectTimeout = 5_000
        // 单次读取的超时，不是总时长：大文件持续有数据就不会触发
        conn.readTimeout = 30_000
        conn.setRequestProperty("Accept", "application/json")
        token?.let { conn.setRequestProperty("Authorization", "Bearer $it") }
        return conn
    }

    /**
     * 先做一次 3 秒的 TCP 探测：能连上再发 HTTP，连不上立刻给出人话原因。
     * 返回 null 表示可达，否则返回错误说明。
     */
    fun probe(): String? {
        val parsed = try {
            url("/")
        } catch (e: Exception) {
            return "地址格式不对：$baseUrl"
        }
        val host = parsed.host ?: return "地址里缺少主机：$baseUrl"
        val port = if (parsed.port > 0) parsed.port else 80
        return try {
            java.net.Socket().use { socket ->
                socket.connect(java.net.InetSocketAddress(host, port), 3000)
            }
            null
        } catch (e: Exception) {
            "连不上 $host:$port（${e.javaClass.simpleName}）。请确认：" +
                "① 手机和电脑连的是同一个 WiFi；" +
                "② 电脑上工具正在运行且地址里是它的局域网 IP；" +
                "③ 电脑防火墙允许 $port 端口"
        }
    }

    private fun readText(conn: HttpURLConnection): String {
        val stream = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
        if (conn.responseCode !in 200..299) {
            val message = try {
                JSONObject(text).optString("error", "HTTP ${conn.responseCode}")
            } catch (e: Exception) {
                "HTTP ${conn.responseCode}"
            }
            throw RemoteException(message)
        }
        return text
    }

    private fun postJson(path: String, body: JSONObject): JSONObject {
        val conn = connect(path, "POST")
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        val payload = body.toString().toByteArray(Charsets.UTF_8)
        conn.setFixedLengthStreamingMode(payload.size)
        conn.outputStream.use { it.write(payload) }
        val text = readText(conn)
        conn.disconnect()
        return if (text.isBlank()) JSONObject() else JSONObject(text)
    }

    /** 不需要配对码的问候接口：用来"测试连接"，确认地址和电脑端都对 */
    fun greet(): Greet {
        val conn = connect("/api/peer/greet", "GET")
        val text = readText(conn)
        conn.disconnect()
        val json = JSONObject(text)
        if (json.optString("app") != "commsync") {
            throw RemoteException("这个地址不是本工具的节点（可能填成了别的服务）")
        }
        return Greet(
            name = json.optString("name", "?"),
            version = json.optString("version", "?"),
            folderCount = json.optInt("folderCount", 0),
        )
    }

    /**
     * 用配对码换令牌（手机上只需要输一次）。
     * 同时把自己的服务端口和一个"给电脑用的令牌"报给电脑——这样电脑也能反向读取手机的文件夹。
     */
    fun pair(
        hostUrl: String,
        code: String,
        deviceName: String,
        deviceId: String,
        serverPort: Int,
        deviceToken: String,
    ): PairResult {
        baseUrl = hostUrl.trimEnd('/')
        val body = JSONObject()
            .put("code", code)
            .put("id", deviceId)
            .put("name", deviceName)
            .put("port", serverPort)
            .put("token", deviceToken)
            .put("kind", "peer")
            .put("platform", "android")
        val json = postJson("/api/pair", body)
        val newToken = json.optString("token")
        if (newToken.isBlank()) throw RemoteException("配对失败：服务器没有返回令牌")
        token = newToken
        return PairResult(newToken, json.optString("id"), json.optString("name"))
    }

    fun folders(): List<RemoteFolder> {
        val json = postJson("/api/peer/folders", JSONObject())
        val array = json.optJSONArray("folders") ?: return emptyList()
        return (0 until array.length()).map { index ->
            val item = array.getJSONObject(index)
            RemoteFolder(item.optString("id"), item.optString("name"), item.optString("path"))
        }
    }

    fun manifest(folderId: String): Manifest {
        val json = postJson("/api/peer/manifest", JSONObject().put("folderId", folderId))
        val files = HashMap<String, FileStat>()
        val objectFiles = json.optJSONObject("files")
        if (objectFiles != null) {
            for (key in objectFiles.keys()) {
                val item = objectFiles.optJSONObject(key) ?: continue
                files[key] = FileStat(item.optLong("size"), item.optLong("mtimeMs"))
            }
        }
        val folder = json.optJSONObject("folder")
        return Manifest(json.optString("root"), folder?.optString("name") ?: "", files)
    }

    fun hashes(folderId: String, paths: List<String>): Map<String, String?> {
        if (paths.isEmpty()) return emptyMap()
        val body = JSONObject().put("folderId", folderId).put("paths", org.json.JSONArray(paths))
        val json = postJson("/api/peer/hashes", body)
        val out = HashMap<String, String?>()
        val hashes = json.optJSONObject("hashes") ?: return out
        for (key in hashes.keys()) {
            out[key] = if (hashes.isNull(key)) null else hashes.optString(key)
        }
        return out
    }

    /** 打开远端文件的下载流（调用方负责读完后 disconnect） */
    fun openDownload(folderId: String, path: String): Pair<HttpURLConnection, InputStream> {
        val query = "folderId=${Uri.encode(folderId)}&path=${Uri.encode(path)}"
        val conn = connect("/api/peer/file?$query", "GET")
        if (conn.responseCode !in 200..299) {
            readText(conn)
            conn.disconnect()
            throw RemoteException("下载失败：HTTP ${conn.responseCode}")
        }
        return conn to conn.inputStream
    }

    /** 上传一个文件，返回服务器落盘后的签名 */
    fun upload(folderId: String, path: String, input: InputStream, size: Long, mtimeMs: Long, sha256: String): String {
        val query = "folderId=${Uri.encode(folderId)}&path=${Uri.encode(path)}"
        val conn = connect("/api/peer/file?$query", "PUT")
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/octet-stream")
        conn.setRequestProperty("X-File-Sha256", sha256)
        conn.setRequestProperty("X-File-Mtime", mtimeMs.toString())
        conn.setFixedLengthStreamingMode(size)
        input.use { source ->
            conn.outputStream.use { sink -> source.copyTo(sink, 64 * 1024) }
        }
        val text = readText(conn)
        conn.disconnect()
        return try {
            JSONObject(text).optString("sig")
        } catch (e: Exception) {
            ""
        }
    }

    fun delete(folderId: String, paths: List<String>) {
        if (paths.isEmpty()) return
        val body = JSONObject().put("folderId", folderId).put("paths", org.json.JSONArray(paths))
        val json = postJson("/api/peer/delete", body)
        val failed = json.optJSONArray("failed")
        if (failed != null && failed.length() > 0) {
            throw RemoteException(failed.getJSONObject(0).optString("error", "远端删除失败"))
        }
    }

    fun copy(folderId: String, from: String, to: String) {
        postJson("/api/peer/copy", JSONObject().put("folderId", folderId).put("from", from).put("to", to))
    }

    fun ping(): Boolean = try {
        val conn = connect("/api/ping", "GET")
        val code = conn.responseCode
        conn.disconnect()
        code == 200
    } catch (e: Exception) {
        false
    }
}
