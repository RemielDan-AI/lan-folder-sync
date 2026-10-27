package com.commsync.mobile

import android.content.Context
import android.os.Build
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * 本地持久化：连接信息、选中的目录、允许删除开关，以及每个"同步项"的基线。
 * 基线是判断"对方删了文件"还是"我这边新加了文件"的唯一依据。
 */
class Store(private val context: Context) {

    data class Settings(
        val baseUrl: String = "",
        val token: String? = null,
        val hostId: String? = null,
        val hostName: String? = null,
        val deviceId: String = "",
        val deviceName: String = "",
        val deviceToken: String? = null,
        val serverPort: Int = 47820,
        val treeUri: String? = null,
        val remoteFolderId: String? = null,
        val allowDeletes: Boolean = false,
    )

    private val settingsFile = File(context.filesDir, "settings.json")
    private val baselineFile = File(context.filesDir, "baselines.json")

    fun loadSettings(): Settings {
        val defaults = Settings(
            deviceId = UUID.randomUUID().toString(),
            deviceName = "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
        )
        if (!settingsFile.exists()) return defaults
        return try {
            val json = JSONObject(settingsFile.readText())
            defaults.copy(
                baseUrl = json.optString("baseUrl", ""),
                token = json.optString("token", "").ifBlank { null },
                hostId = json.optString("hostId", "").ifBlank { null },
                hostName = json.optString("hostName", "").ifBlank { null },
                deviceId = json.optString("deviceId", "").ifBlank { defaults.deviceId },
                deviceName = json.optString("deviceName", "").ifBlank { defaults.deviceName },
                deviceToken = json.optString("deviceToken", "").ifBlank { null },
                serverPort = json.optInt("serverPort", 47820).let { if (it <= 0) 47820 else it },
                treeUri = json.optString("treeUri", "").ifBlank { null },
                remoteFolderId = json.optString("remoteFolderId", "").ifBlank { null },
                allowDeletes = json.optBoolean("allowDeletes", false),
            )
        } catch (e: Exception) {
            defaults
        }
    }

    fun saveSettings(settings: Settings) {
        val json = JSONObject()
            .put("baseUrl", settings.baseUrl)
            .put("token", settings.token ?: "")
            .put("hostId", settings.hostId ?: "")
            .put("hostName", settings.hostName ?: "")
            .put("deviceId", settings.deviceId)
            .put("deviceName", settings.deviceName)
            .put("deviceToken", settings.deviceToken ?: "")
            .put("serverPort", settings.serverPort)
            .put("treeUri", settings.treeUri ?: "")
            .put("remoteFolderId", settings.remoteFolderId ?: "")
            .put("allowDeletes", settings.allowDeletes)
        settingsFile.writeText(json.toString())
    }

    /** 基线键：本机目录 + 对端 + 对方文件夹，三者一变就是另一条同步项 */
    fun baselineKey(treeUri: String, hostId: String?, remoteFolderId: String?): String =
        "$treeUri|${hostId ?: ""}|${remoteFolderId ?: ""}"

    @Synchronized
    fun loadBaseline(key: String): MutableMap<String, BaseEntry> {
        if (!baselineFile.exists()) return HashMap()
        return try {
            val root = JSONObject(baselineFile.readText())
            val bucket = root.optJSONObject(key) ?: return HashMap()
            val out = HashMap<String, BaseEntry>()
            for (path in bucket.keys()) {
                val item = bucket.optJSONObject(path) ?: continue
                out[path] = BaseEntry(
                    hash = item.optString("hash", "").ifBlank { null },
                    remoteHash = item.optString("remoteHash", "").ifBlank { null },
                    localSig = item.optString("localSig", "").ifBlank { null },
                    remoteSig = item.optString("remoteSig", "").ifBlank { null },
                )
            }
            out
        } catch (e: Exception) {
            HashMap()
        }
    }

    @Synchronized
    fun saveBaseline(key: String, entries: Map<String, BaseEntry>) {
        val root = try {
            if (baselineFile.exists()) JSONObject(baselineFile.readText()) else JSONObject()
        } catch (e: Exception) {
            JSONObject()
        }
        val bucket = JSONObject()
        for ((path, entry) in entries) {
            bucket.put(
                path,
                JSONObject()
                    .put("hash", entry.hash ?: "")
                    .put("remoteHash", entry.remoteHash ?: "")
                    .put("localSig", entry.localSig ?: "")
                    .put("remoteSig", entry.remoteSig ?: ""),
            )
        }
        root.put(key, bucket)
        baselineFile.writeText(root.toString())
    }
}
