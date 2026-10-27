package com.commsync.mobile

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import java.security.DigestOutputStream
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * 手机端主界面。
 * 与桌面版同一套流程：连接 → 选本地目录（SAF，可持久读写）→ 选对方文件夹 → 对比 → 冲突自己选 → 执行。
 * 刻意不引入 AndroidX：一个 Activity + 代码里搭视图，构建只依赖 AGP/Kotlin。
 */
class MainActivity : Activity() {

    companion object {
        private const val REQ_TREE = 1001
        private const val REQ_SAVE = 1002

        private val BG = Color.parseColor("#0B1020")
        private val CARD = Color.parseColor("#151D31")
        private val TEXT = Color.parseColor("#F8FAFC")
        private val DIM = Color.parseColor("#9AA8BD")
        private val ACCENT = Color.parseColor("#22C55E")
        private val WARN = Color.parseColor("#FBBF24")
        private val DANGER = Color.parseColor("#F87171")
        private val INFO = Color.parseColor("#38BDF8")
    }

    private lateinit var store: Store
    private var settings = Store.Settings()
    private var client: RemoteClient? = null
    private var tree: LocalTree? = null
    private var server: PeerServer? = null
    private var deviceToken = ""
    private var plan: SyncEngine.Plan? = null
    private var remoteFolders: List<RemoteClient.RemoteFolder> = emptyList()
    private var busy = false

    /** 桌面端可以直接读取的手机目录；这里反过来：手机也能主动拉电脑的文件（不参与同步） */
    data class RemoteFile(val path: String, val size: Long, val mtimeMs: Long)

    private data class PendingDownload(val path: String, val name: String)

    private var remoteFiles: List<RemoteFile>? = null
    private var pendingDownload: PendingDownload? = null

    private val io = Executors.newSingleThreadExecutor()
    private val ui = Handler(Looper.getMainLooper())

    private lateinit var hostInput: EditText
    private lateinit var codeInput: EditText
    private lateinit var statusText: TextView
    private lateinit var connectButton: Button
    private lateinit var serverText: TextView
    private lateinit var localLabel: TextView
    private lateinit var folderSpinner: Spinner
    private lateinit var summaryText: TextView
    private lateinit var rowsBox: LinearLayout
    private lateinit var logText: TextView
    private lateinit var allowDeletesBox: CheckBox
    private lateinit var compareButton: Button
    private lateinit var oneClickButton: Button
    private lateinit var remoteFilesBox: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        settings = store.loadSettings()
        buildUi()
        startPeerServer()
        restoreState()
    }

    /**
     * 在手机上开一个小服务，把选中的 SAF 目录按同一套协议暴露给电脑。
     * 这样电脑端也能列手机的文件夹、主动对比和拉取——不再只能由手机推。
     */
    private fun startPeerServer() {
        deviceToken = settings.deviceToken ?: randomToken().also {
            settings = settings.copy(deviceToken = it)
            store.saveSettings(settings)
        }
        val peerServer = PeerServer(
            context = this,
            deviceId = settings.deviceId,
            deviceName = settings.deviceName,
            token = deviceToken,
            preferredPort = settings.serverPort,
            onLog = { line -> log(line) },
        )
        val port = peerServer.start()
        server = peerServer
        server?.updateTree(tree)
        if (port > 0) {
            settings = settings.copy(serverPort = port)
            store.saveSettings(settings)
            serverText.text = "本机服务已开启（端口 $port）：电脑端可以直接读取这台手机的文件夹。改动后需要重新点一次「连接并配对」，电脑才会拿到访问令牌。"
            serverText.setTextColor(ACCENT)
        } else {
            serverText.text = "本机服务没能启动：电脑端暂时只能由手机发起同步。"
            serverText.setTextColor(WARN)
        }
    }

    private fun randomToken(): String {
        val bytes = ByteArray(20)
        java.security.SecureRandom().nextBytes(bytes)
        return toHex(bytes)
    }

    override fun onDestroy() {
        // 不 shutdown 线程池：Activity 重建后点击会抛 RejectedExecutionException，
        // 单 Activity 应用直接随进程退出即可
        server?.stop()
        super.onDestroy()
    }

    /* ------------------------------------------------------------ 视图搭建 */

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun card(title: String): LinearLayout {
        val box = LinearLayout(this)
        box.orientation = LinearLayout.VERTICAL
        box.setPadding(dp(14), dp(12), dp(14), dp(14))
        box.setBackgroundColor(CARD)
        val params = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        params.bottomMargin = dp(10)
        box.layoutParams = params

        val header = TextView(this)
        header.text = title
        header.setTextColor(DIM)
        header.textSize = 12f
        header.letterSpacing = 0.06f
        header.setPadding(0, 0, 0, dp(8))
        box.addView(header)
        return box
    }

    private fun text(value: String, size: Float = 13f, color: Int = TEXT): TextView {
        val view = TextView(this)
        view.text = value
        view.textSize = size
        view.setTextColor(color)
        return view
    }

    private fun actionButton(label: String, primary: Boolean = false, handler: () -> Unit): Button {
        val button = Button(this)
        button.text = label
        button.isAllCaps = false
        button.textSize = 13f
        button.setTextColor(if (primary) Color.parseColor("#04240F") else TEXT)
        button.setBackgroundColor(if (primary) ACCENT else Color.parseColor("#1E293B"))
        button.setPadding(dp(12), dp(6), dp(12), dp(6))
        button.setOnClickListener {
            if (busy) {
                toast("上一个操作还在进行，请稍候")
                return@setOnClickListener
            }
            handler()
        }
        return button
    }

    private fun buildUi() {
        val page = LinearLayout(this)
        page.orientation = LinearLayout.VERTICAL
        page.setBackgroundColor(BG)
        page.setPadding(dp(12), dp(24), dp(12), dp(24))

        val title = text("局域网同步", 20f)
        title.setTypeface(Typeface.DEFAULT_BOLD)
        page.addView(title)
        page.addView(text("和电脑上的 Communication 工具配对，双向同步一个文件夹", 12f, DIM).apply {
            setPadding(0, dp(2), 0, dp(14))
        })

        /* --- 连接 --- */
        val connectCard = card("1 · 连接电脑")
        hostInput = EditText(this).apply {
            hint = "电脑 IP:端口，例如 192.168.1.6:47800"
            setText(settings.baseUrl)
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            textSize = 13f
            setTextColor(TEXT)
            setHintTextColor(DIM)
        }
        codeInput = EditText(this).apply {
            hint = "电脑上的 6 位配对码"
            inputType = InputType.TYPE_CLASS_NUMBER
            textSize = 13f
            setTextColor(TEXT)
            setHintTextColor(DIM)
        }
        connectCard.addView(hostInput)
        connectCard.addView(codeInput)
        statusText = text("未连接", 12f, DIM).apply { setPadding(0, dp(6), 0, dp(8)) }
        connectCard.addView(statusText)
        val connectRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val testButton = actionButton("测试连接") { testConnection() }
        connectButton = actionButton("连接并配对", primary = true) { connect() }
        connectRow.addView(
            testButton,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { rightMargin = dp(8) },
        )
        connectRow.addView(connectButton, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        connectCard.addView(connectRow)
        serverText = text("", 11f, DIM).apply { setPadding(0, dp(8), 0, 0) }
        connectCard.addView(serverText)
        connectCard.addView(text("地址只填 IP:端口 就行，http:// 会自动补上；端口不填默认 47800。「测试连接」不需要配对码。", 11f, DIM).apply {
            setPadding(0, dp(8), 0, 0)
        })
        page.addView(connectCard)

        /* --- 文件夹 --- */
        val folderCard = card("2 · 选择文件夹")
        localLabel = text("本地：未选择", 12f, DIM)
        folderCard.addView(localLabel)
        folderCard.addView(actionButton("选择手机上的文件夹") { pickFolder() }.apply {
            val params = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            params.topMargin = dp(8)
            layoutParams = params
        })
        folderSpinner = Spinner(this).apply {
            val params = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            params.topMargin = dp(10)
            layoutParams = params
        }
        folderCard.addView(text("对方共享的文件夹：", 12f, DIM).apply { setPadding(0, dp(10), 0, 0) })
        folderCard.addView(folderSpinner)
        folderCard.addView(actionButton("刷新对方的文件夹") { refreshFolders() })
        page.addView(folderCard)

        /* --- 操作 --- */
        val actionCard = card("3 · 对比与执行")
        allowDeletesBox = CheckBox(this).apply {
            text = "允许同步删除操作"
            setTextColor(DIM)
            textSize = 12f
            isChecked = settings.allowDeletes
            setOnCheckedChangeListener { _, checked ->
                settings = settings.copy(allowDeletes = checked)
                store.saveSettings(settings)
            }
        }
        actionCard.addView(allowDeletesBox)
        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        compareButton = actionButton("对比") { compare() }
        oneClickButton = actionButton("一键同步", primary = true) { oneClickSync() }
        val rowParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        rowParams.rightMargin = dp(8)
        row.addView(compareButton, rowParams)
        row.addView(oneClickButton, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        actionCard.addView(row)
        summaryText = text("还没有对比", 12f, DIM).apply { setPadding(0, dp(10), 0, 0) }
        actionCard.addView(summaryText)
        page.addView(actionCard)

        /* --- 结果 --- */
        val planCard = card("4 · 对比结果")
        rowsBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        planCard.addView(rowsBox)
        page.addView(planCard)

        /* --- 远端文件：直接下载，不参与同步 --- */
        val remoteCard = card("5 · 远端文件（下载）")
        remoteCard.addView(text("列出电脑上的文件，点「下载」直接存到手机。只下载，不改本机同步文件夹、不进基线。", 11f, DIM))
        remoteCard.addView(actionButton("刷新远端文件列表") { loadRemoteFiles() }.apply {
            val params = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            params.topMargin = dp(8)
            layoutParams = params
        })
        remoteFilesBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        remoteCard.addView(remoteFilesBox)
        page.addView(remoteCard)

        /* --- 日志 --- */
        val logCard = card("日志")
        logText = text("", 11f, DIM).apply {
            typeface = Typeface.MONOSPACE
            setPadding(0, dp(2), 0, dp(2))
        }
        val logScroll = ScrollView(this).apply {
            addView(logText)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(160))
        }
        logCard.addView(logScroll)
        page.addView(logCard)

        val scroll = ScrollView(this)
        scroll.setBackgroundColor(BG)
        scroll.addView(page)
        setContentView(scroll)
    }

    /* ------------------------------------------------------------ 状态恢复 */

    private fun restoreState() {
        if (settings.baseUrl.isNotBlank()) {
            client = RemoteClient(settings.baseUrl, settings.token)
            statusText.text = if (settings.token != null) {
                "已配对：${settings.hostName ?: settings.baseUrl}"
            } else {
                "地址已填，还没配对"
            }
        }
        settings.treeUri?.let { uriString ->
            try {
                val uri = Uri.parse(uriString)
                tree = LocalTree(this, uri)
                localLabel.text = "本地：${tree?.label()}"
            } catch (e: Exception) {
                localLabel.text = "本地：目录授权已失效，请重新选择"
            }
        }
        server?.updateTree(tree)
        if (client?.token != null) refreshFolders()
    }

    /* ------------------------------------------------------------ 交互动作 */

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    private fun log(line: String) {
        ui.post {
            val current = logText.text.toString()
            val lines = (current.split("\n").takeLast(120) + formatTime(System.currentTimeMillis()) + "  " + line)
            logText.text = lines.joinToString("\n")
        }
    }

    private fun setBusy(value: Boolean) {
        busy = value
        ui.post {
            compareButton.isEnabled = !value
            oneClickButton.isEnabled = !value
        }
    }

    private fun runIo(task: () -> Unit) {
        io.execute {
            try {
                task()
            } catch (t: Throwable) {
                // Throwable 而不是 Exception：像 NoClassDefFoundError 这类错误也要说人话，不能静默死掉
                val message = t.message?.takeIf { it.isNotBlank() }
                    ?: "${t.javaClass.simpleName}（没有更多信息）"
                ui.post { toast(message) }
                setStatus("失败：$message", DANGER)
                log("× $message")
            } finally {
                setBusy(false)
                ui.post {
                    connectButton.isEnabled = true
                    connectButton.text = "连接并配对"
                }
            }
        }
    }

    private fun setStatus(message: String, color: Int) {
        ui.post {
            statusText.text = message
            statusText.setTextColor(color)
        }
    }

    /** 不需要配对码的连通性测试：先确认"地址对不对、电脑在不在"，再去配对 */
    private fun testConnection() {
        val rawHost = hostInput.text.toString().trim()
        if (rawHost.isEmpty()) {
            setStatus("先填电脑的 IP:端口，例如 192.168.1.6:47800", DANGER)
            return toast("先填电脑地址")
        }
        val baseUrl = normalizeBaseUrl(rawHost)
        hostInput.setText(baseUrl)
        setStatus("正在测试 $baseUrl …", DIM)
        log("测试连接 $baseUrl")
        setBusy(true)
        runIo {
            val temp = RemoteClient(baseUrl, null)
            temp.probe()?.let { throw RemoteException(it) }
            val greet = temp.greet()
            setStatus("地址可用：${greet.name}（v${greet.version}，共享 ${greet.folderCount} 个文件夹）", ACCENT)
            log("测试通过：${greet.name} v${greet.version}")
            ui.post { toast("连接正常") }
        }
    }

    private fun connect() {
        val rawHost = hostInput.text.toString().trim()
        val code = codeInput.text.toString().trim()

        if (rawHost.isEmpty()) {
            setStatus("请先填电脑的 IP:端口，例如 192.168.1.6:47800", DANGER)
            return toast("请先填电脑地址")
        }

        // 只填 IP:端口 就行，协议和端口自动补
        val baseUrl = normalizeBaseUrl(rawHost)
        hostInput.setText(baseUrl)

        // 已经配对过、这次没填配对码：不用重复配对，直接刷新文件夹
        if (code.isEmpty() && settings.token != null && settings.baseUrl == baseUrl) {
            setStatus("已配对过，正在刷新对方的文件夹…", DIM)
            refreshFolders()
            return
        }
        if (!Regex("^\\d{6}$").matches(code)) {
            setStatus("配对码是 6 位数字，在电脑界面「本机」卡片里", WARN)
            return toast("配对码是 6 位数字")
        }

        setStatus("正在连接 $baseUrl …", DIM)
        connectButton.isEnabled = false
        connectButton.text = "连接中…"
        log("开始连接 $baseUrl")
        setBusy(true)

        runIo {
            val temp = RemoteClient(baseUrl, null)
            // 先用 3 秒的 TCP 探测，连不上就立刻给原因，不要让用户以为点击没反应
            temp.probe()?.let { throw RemoteException(it) }
            // 服务没起来就别谎报端口和令牌：对端会按"纯客户端"处理，而不是记下一个连不上的地址
            val serving = (server?.runningPort ?: 0) > 0
            val result = temp.pair(
                baseUrl,
                code,
                settings.deviceName,
                settings.deviceId,
                if (serving) settings.serverPort else 0,
                if (serving) deviceToken else "",
            )
            settings = settings.copy(
                baseUrl = baseUrl,
                token = result.token,
                hostId = result.hostId,
                hostName = result.hostName,
            )
            store.saveSettings(settings)
            client = temp
            setStatus("已配对：${result.hostName}", ACCENT)
            ui.post { toast("配对成功") }
            log("配对成功：${result.hostName}")
            refreshFoldersBlocking()
        }
    }

    private fun refreshFolders() {
        if (client?.token == null) return toast("先完成配对")
        setBusy(true)
        runIo { refreshFoldersBlocking() }
    }

    private fun refreshFoldersBlocking() {
        val current = client ?: return
        val folders = current.folders()
        remoteFolders = folders
        ui.post {
            val names = folders.map { "${it.name}（${it.path}）" }
            val adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, names)
            adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
            folderSpinner.adapter = adapter
            val savedIndex = folders.indexOfFirst { it.id == settings.remoteFolderId }
            if (savedIndex >= 0) folderSpinner.setSelection(savedIndex)
        }
        log("对方共享了 ${folders.size} 个文件夹")
        if (folders.isEmpty()) {
            setStatus("电脑上还没有共享文件夹：请到电脑界面点「我的文件夹 → 添加」选一个，手机这里才选得到同步目标", WARN)
            ui.post { toast("电脑上还没有共享文件夹") }
        } else {
            log("对方的共享文件夹：" + folders.joinToString("、") { it.name })
        }
    }

    private fun currentRemoteFolder(): RemoteClient.RemoteFolder? {
        val index = folderSpinner.selectedItemPosition
        val folder = remoteFolders.getOrNull(index) ?: remoteFolders.firstOrNull() ?: return null
        if (settings.remoteFolderId != folder.id) {
            settings = settings.copy(remoteFolderId = folder.id)
            store.saveSettings(settings)
        }
        return folder
    }

    private fun pickFolder() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
            )
        }
        startActivityForResult(intent, REQ_TREE)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_SAVE) {
            val pending = pendingDownload
            pendingDownload = null
            if (resultCode != RESULT_OK || pending == null) return
            val target = data?.data ?: return
            downloadTo(target, pending)
            return
        }
        if (requestCode != REQ_TREE || resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        try {
            contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        } catch (e: Exception) {
            toast("无法保存目录授权：${e.message}")
        }
        tree = LocalTree(this, uri)
        settings = settings.copy(treeUri = uri.toString())
        store.saveSettings(settings)
        // 手机端服务要用最新的目录，否则电脑端看到的还是旧的（或空的）
        server?.updateTree(tree)
        localLabel.text = "本地：${tree?.label()}"
        plan = null
        renderPlan()
        log("已选择本地目录：${tree?.label()}")
    }

    private fun engineFor(folder: RemoteClient.RemoteFolder): SyncEngine {
        val activeTree = tree ?: throw RemoteException("还没有选择手机上的文件夹")
        val activeClient = client ?: throw RemoteException("还没有连接电脑")
        val key = store.baselineKey(activeTree.treeUri.toString(), settings.hostId, folder.id)
        return SyncEngine(activeClient, activeTree, store, key)
    }

    private fun compare(after: (() -> Unit)? = null) {
        val folder = currentRemoteFolder() ?: return toast("先选对方的文件夹")
        if (tree == null) return toast("先选手机上的文件夹")
        setBusy(true)
        ui.post { summaryText.text = "正在对比…" }
        runIo {
            val engine = engineFor(folder)
            val result = engine.scan(folder.id) { line -> log(line) }
            plan = result
            seedRemoteFiles(result.entries)
            ui.post { renderPlan() }
            val summary = summarize(result.entries)
            log("对比完成：待上传 ${summary.upload}，待下载 ${summary.download}，冲突 ${summary.conflicts}")
            after?.invoke()
        }
    }

    private fun oneClickSync() {
        val folder = currentRemoteFolder() ?: return toast("先选对方的文件夹")
        if (tree == null) return toast("先选手机上的文件夹")
        setBusy(true)
        ui.post { summaryText.text = "正在对比…" }
        runIo {
            val engine = engineFor(folder)
            val result = engine.scan(folder.id) { line -> log(line) }
            plan = result
            seedRemoteFiles(result.entries)
            val summary = summarize(result.entries)
            ui.post { renderPlan() }

            if (summary.pendingConflicts > 0) {
                ui.post { toast("有 ${summary.pendingConflicts} 个冲突需要你选") }
                log("有冲突，已停下等你选择")
                return@runIo
            }
            val ops = result.entries.count { it.action != Action.NONE }
            if (ops == 0) {
                log("两端已经一致，无需操作")
                ui.post { toast("两端已经一致") }
                return@runIo
            }
            val applied = engine.apply(folder.id, result.entries, settings.allowDeletes) { line -> log(line) }
            log("执行完成：成功 ${applied.ok}，失败 ${applied.failed}")
            val refreshed = engine.scan(folder.id) { line -> log(line) }
            plan = refreshed
            ui.post {
                renderPlan()
                toast(if (applied.failed > 0) "完成，${applied.ok} 成功 / ${applied.failed} 失败" else "同步完成，${applied.ok} 项")
            }
        }
    }

    private fun applyPlan() {
        val folder = currentRemoteFolder() ?: return toast("先选对方的文件夹")
        val current = plan ?: return toast("先对比")
        val summary = summarize(current.entries)
        if (summary.pendingConflicts > 0) return toast("还有 ${summary.pendingConflicts} 个冲突没决定")
        setBusy(true)
        runIo {
            val engine = engineFor(folder)
            val applied = engine.apply(folder.id, current.entries, settings.allowDeletes) { line -> log(line) }
            log("执行完成：成功 ${applied.ok}，失败 ${applied.failed}")
            val refreshed = engine.scan(folder.id) { line -> log(line) }
            plan = refreshed
            ui.post {
                renderPlan()
                toast("同步完成，${applied.ok} 项")
            }
        }
    }

    /* -------------------------------------------------- 远端文件（直接下载） */

    private fun seedRemoteFiles(entries: List<Entry>) {
        remoteFiles = entries
            .filter { it.remote != null }
            .map { RemoteFile(it.path, it.remote!!.size, it.remote!!.mtimeMs) }
            .sortedBy { it.path }
        ui.post { renderRemoteFiles() }
    }

    private fun loadRemoteFiles() {
        val folder = currentRemoteFolder() ?: return toast("先选对方的文件夹")
        val active = client ?: return toast("先完成配对")
        setBusy(true)
        runIo {
            val manifest = active.manifest(folder.id)
            remoteFiles = manifest.files.entries
                .map { RemoteFile(it.key, it.value.size, it.value.mtimeMs) }
                .sortedBy { it.path }
            ui.post { renderRemoteFiles() }
            log("远端文件：${remoteFiles?.size ?: 0} 个")
            if (remoteFiles.isNullOrEmpty()) ui.post { toast("对方文件夹是空的") }
        }
    }

    private fun renderRemoteFiles() {
        remoteFilesBox.removeAllViews()
        val files = remoteFiles
        if (files == null) {
            remoteFilesBox.addView(text("还没读取，点上面的「刷新远端文件列表」；或者先做一次对比。", 12f, DIM))
            return
        }
        if (files.isEmpty()) {
            remoteFilesBox.addView(text("对方这个文件夹里没有文件。", 12f, DIM))
            return
        }
        for (file in files.take(200)) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, dp(6), 0, dp(6))
                gravity = Gravity.CENTER_VERTICAL
            }
            val info = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            info.addView(text(file.path, 12f).apply { typeface = Typeface.MONOSPACE })
            info.addView(text("${formatBytes(file.size)} · ${formatStamp(file.mtimeMs)}", 11f, DIM))
            row.addView(info, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            row.addView(smallButton("下载") { startDownload(file.path) })
            remoteFilesBox.addView(row)
        }
        if (files.size > 200) {
            remoteFilesBox.addView(text("还有 ${files.size - 200} 个未显示", 11f, DIM))
        }
    }

    /** 让用户选一个保存位置（SAF），再流式下载过去 —— 不经过同步目录 */
    private fun startDownload(rel: String) {
        val name = rel.substringAfterLast('/')
        pendingDownload = PendingDownload(rel, name)
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeForName(name)
            putExtra(Intent.EXTRA_TITLE, name)
        }
        startActivityForResult(intent, REQ_SAVE)
    }

    private fun downloadTo(target: Uri, pending: PendingDownload) {
        val folder = currentRemoteFolder() ?: return toast("先选对方的文件夹")
        val active = client ?: return toast("先完成配对")
        setBusy(true)
        log("开始下载 ${pending.path}")
        runIo {
            // 能拿到哈希就先拿，落盘后校验一次，避免"看起来存好了其实是坏的"
            val expected = active.hashes(folder.id, listOf(pending.path))[pending.path]
            val (conn, stream) = active.openDownload(folder.id, pending.path)
            val digest = MessageDigest.getInstance("SHA-256")
            var written = 0L
            val sink = contentResolver.openOutputStream(target, "wt")
                ?: throw RemoteException("无法写入所选位置")
            sink.use { out ->
                val hashing = DigestOutputStream(out, digest)
                stream.use { source ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = source.read(buffer)
                        if (read <= 0) break
                        hashing.write(buffer, 0, read)
                        written += read
                    }
                }
                hashing.flush()
            }
            conn.disconnect()

            val actual = toHex(digest.digest())
            if (expected != null && actual != expected) {
                try {
                    DocumentsContract.deleteDocument(contentResolver, target)
                } catch (e: Exception) {
                    // 删不掉也不影响报错
                }
                throw RemoteException("校验失败：下载内容与远端不一致，已删除")
            }
            ui.post { toast("已保存：${pending.name}") }
            log("已保存 ${pending.name}（${formatBytes(written)}）")
        }
    }

    private fun smallButton(label: String, handler: () -> Unit): Button {
        val button = Button(this)
        button.text = label
        button.isAllCaps = false
        button.textSize = 11f
        button.setTextColor(TEXT)
        button.setBackgroundColor(Color.parseColor("#1E293B"))
        button.minHeight = 0
        button.minimumHeight = 0
        button.setPadding(dp(8), 0, dp(8), 0)
        button.setOnClickListener { if (!busy) handler() else toast("上一个操作还在进行，请稍候") }
        return button
    }

    /* ------------------------------------------------------------ 结果渲染 */

    private fun renderPlan() {
        rowsBox.removeAllViews()
        val current = plan
        if (current == null) {
            summaryText.text = "还没有对比"
            rowsBox.addView(text("点「对比」只做检查，不会改动任何文件。", 12f, DIM))
            return
        }
        val summary = summarize(current.entries)
        summaryText.text = buildString {
            append("对端：${current.remoteFolderName.ifBlank { current.remoteRoot }}\n")
            append("上传 ${summary.upload} · 下载 ${summary.download} · 删除 ${summary.deletes} · 冲突 ${summary.conflicts} · 一致 ${summary.same}")
        }
        summaryText.setTextColor(if (summary.pendingConflicts > 0) WARN else DIM)

        val visible = current.entries.filter { it.kind != Kind.SAME && it.kind != Kind.BOTH_DELETED }
        if (visible.isEmpty()) {
            rowsBox.addView(text("两端已经完全一致。", 13f, ACCENT))
            return
        }

        for (entry in visible.take(200)) {
            rowsBox.addView(buildRow(entry))
        }
        if (visible.size > 200) {
            rowsBox.addView(text("还有 ${visible.size - 200} 项未显示（可先处理这些）", 11f, DIM))
        }
        if (summary.pendingConflicts == 0 && summary.upload + summary.download + summary.deletes > 0) {
            rowsBox.addView(actionButton("执行同步（${summary.upload + summary.download + summary.deletes} 项）", primary = true) { applyPlan() })
        }
    }

    private fun buildRow(entry: Entry): LinearLayout {
        val row = LinearLayout(this)
        row.orientation = LinearLayout.VERTICAL
        row.setPadding(dp(10), dp(8), dp(10), dp(8))
        row.setBackgroundColor(Color.parseColor("#0F172A"))
        val params = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        params.bottomMargin = dp(6)
        row.layoutParams = params

        val path = text(entry.path, 12f)
        path.typeface = Typeface.MONOSPACE
        row.addView(path)

        val sizeText = when {
            entry.local != null && entry.remote != null -> "本地 ${formatBytes(entry.local!!.size)} · 远端 ${formatBytes(entry.remote!!.size)}"
            entry.local != null -> "本地 ${formatBytes(entry.local!!.size)}"
            entry.remote != null -> "远端 ${formatBytes(entry.remote!!.size)}"
            else -> ""
        }
        val tone = when {
            entry.kind.isConflict -> WARN
            entry.action == Action.UPLOAD -> ACCENT
            entry.action == Action.DOWNLOAD -> INFO
            entry.action == Action.DELETE_LOCAL || entry.action == Action.DELETE_REMOTE -> DANGER
            else -> DIM
        }
        val meta = text("${entry.kind.label} · $sizeText", 11f, tone)
        row.addView(meta)
        if (entry.note.isNotBlank()) row.addView(text(entry.note, 11f, DIM))

        if (entry.kind.isConflict) {
            val buttons = LinearLayout(this)
            buttons.orientation = LinearLayout.HORIZONTAL
            buttons.setPadding(0, dp(6), 0, 0)
            when (entry.kind) {
                Kind.CONFLICT_DELETE_MODIFY -> {
                    val keepLabel = if (entry.survivor == "local") "保留文件（补回远端）" else "保留文件（拉回本地）"
                    val dropLabel = if (entry.survivor == "local") "接受删除（删本地）" else "接受删除（删远端）"
                    buttons.addView(choiceButton(entry, "keep-local", keepLabel))
                    buttons.addView(choiceButton(entry, "keep-remote", dropLabel))
                }
                else -> {
                    buttons.addView(choiceButton(entry, "keep-local", "保留本地"))
                    buttons.addView(choiceButton(entry, "keep-remote", "保留远端"))
                    buttons.addView(choiceButton(entry, "keep-both", "两个都留"))
                }
            }
            buttons.addView(choiceButton(entry, "skip", "跳过"))
            row.addView(buttons)
            // 选过之后给个明确反馈，否则四个按钮看不出当前决定
            val chosen = when (entry.action) {
                Action.UPLOAD -> "当前选择：保留本地 → 同步到远端"
                Action.DOWNLOAD -> "当前选择：保留远端 → 同步到本地"
                Action.DELETE_LOCAL -> "当前选择：删除本地"
                Action.DELETE_REMOTE -> "当前选择：删除远端"
                Action.KEEP_BOTH -> "当前选择：两个都留（对方那版存副本）"
                Action.NONE -> "还没决定"
            }
            row.addView(text(chosen, 11f, if (entry.action == Action.NONE) WARN else ACCENT).apply {
                setPadding(0, dp(4), 0, 0)
            })
        } else {
            val label = when (entry.action) {
                Action.UPLOAD -> "将同步到远端（用本机这份覆盖电脑）"
                Action.DOWNLOAD -> "将同步到本地（用电脑那份覆盖本机）"
                Action.DELETE_LOCAL -> if (settings.allowDeletes) "将删除本地" else "删除本地（未开启）"
                Action.DELETE_REMOTE -> if (settings.allowDeletes) "将删除远端" else "删除远端（未开启）"
                else -> "跳过"
            }
            row.addView(text(label, 11f, tone).apply { setPadding(0, dp(4), 0, 0) })
        }
        return row
    }

    private fun choiceButton(entry: Entry, choice: String, label: String): Button {
        val button = Button(this)
        button.text = label
        button.isAllCaps = false
        button.textSize = 11f
        button.setTextColor(TEXT)
        button.setBackgroundColor(Color.parseColor("#1E293B"))
        button.minHeight = 0
        button.minimumHeight = 0
        button.setPadding(dp(8), 0, dp(8), 0)
        val params = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        params.rightMargin = dp(6)
        button.layoutParams = params
        button.setOnClickListener {
            applyChoice(entry, choice)
            renderPlan()
        }
        return button
    }
}
