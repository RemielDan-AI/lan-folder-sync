package com.commsync.mobile

import org.json.JSONObject
import java.io.InputStream

/**
 * HTTP 请求体读取。
 *
 * 这里单独抽出来是因为踩过一个坑：某个路由先把 body 读空、又去读同样长度，
 * 结果第二次永远等不到数据，连接就挂住了（电脑端表现为"无法连接对端"）。
 * 现在规定：**一个请求只允许读一次 body**，POST 在路由前统一读好。
 */
object HttpBody {

    const val MAX_JSON_BYTES = 4 * 1024 * 1024

    /** 按 Content-Length 精确读取；超过上限直接截断返回空，避免被撑爆内存 */
    fun readExact(input: InputStream, length: Long, limit: Int = MAX_JSON_BYTES): ByteArray {
        if (length <= 0) return ByteArray(0)
        if (length > limit) {
            discard(input, length)
            return ByteArray(0)
        }
        val buffer = ByteArray(length.toInt())
        var offset = 0
        while (offset < buffer.size) {
            val read = input.read(buffer, offset, buffer.size - offset)
            if (read < 0) break
            offset += read
        }
        return if (offset == buffer.size) buffer else buffer.copyOf(offset)
    }

    /** 把超限的 body 丢掉，保证连接状态干净 */
    fun discard(input: InputStream, length: Long) {
        var remaining = length
        val buffer = ByteArray(8 * 1024)
        while (remaining > 0) {
            val read = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
            if (read < 0) return
            remaining -= read
        }
    }

    fun jsonOf(bytes: ByteArray): JSONObject {
        if (bytes.isEmpty()) return JSONObject()
        return try {
            JSONObject(String(bytes, Charsets.UTF_8))
        } catch (e: Exception) {
            JSONObject()
        }
    }
}
