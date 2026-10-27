package com.commsync.mobile

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 大小/时间/哈希的小工具，界面和执行层共用 */

fun formatBytes(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val units = arrayOf("KB", "MB", "GB", "TB")
    var value = bytes.toDouble() / 1024
    var index = 0
    while (value >= 1024 && index < units.size - 1) {
        value /= 1024
        index++
    }
    return if (value >= 100) String.format(Locale.US, "%.0f %s", value, units[index])
    else String.format(Locale.US, "%.1f %s", value, units[index])
}

fun formatStamp(millis: Long): String =
    SimpleDateFormat("yyyy-MM-dd HH-mm-ss", Locale.US).format(Date(millis))

fun formatTime(millis: Long): String =
    SimpleDateFormat("MM-dd HH:mm", Locale.US).format(Date(millis))

fun toHex(bytes: ByteArray): String {
    val out = StringBuilder(bytes.size * 2)
    for (b in bytes) out.append(String.format(Locale.US, "%02x", b))
    return out.toString()
}

/**
 * 按扩展名猜 MIME。SAF 的"另存为"需要它，猜错也不影响写文件。
 */
fun mimeForName(name: String): String {
    val dot = name.lastIndexOf('.')
    if (dot < 0 || dot == name.length - 1) return "application/octet-stream"
    val ext = name.substring(dot + 1).lowercase()
    return try {
        android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
    } catch (e: Exception) {
        "application/octet-stream"
    }
}

/**
 * 把用户输入的地址补全成 baseUrl：
 *   192.168.1.6            → http://192.168.1.6:47800
 *   192.168.1.6:47800      → http://192.168.1.6:47800
 *   http://192.168.1.6/    → http://192.168.1.6:47800
 * 也就是 http:// 和端口都可以省，省了自动补。
 * 用 java.net.URI 而不是 android.net.Uri：这样这段逻辑能在 JVM 单测里跑。
 */
fun normalizeBaseUrl(raw: String, defaultPort: Int = 47800): String {
    var value = raw.trim().filterNot { it == ' ' || it == '\t' }
    if (value.isEmpty()) return ""
    if (!value.startsWith("http://", ignoreCase = true) && !value.startsWith("https://", ignoreCase = true)) {
        value = "http://$value"
    }
    value = value.trimEnd('/')
    val port = try {
        java.net.URI(value).port
    } catch (e: Exception) {
        -1
    }
    return if (port > 0) value else "$value:$defaultPort"
}
