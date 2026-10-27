package com.commsync.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 差异引擎的 JVM 单测：场景与桌面版 test/diff.test.mjs 一一对应，
 * 保证手机端和电脑端对同一个文件夹得出同样结论。
 */
class DiffTest {

    private fun stat(size: Long, mtime: Long) = FileStat(size, mtime)

    private fun base(hash: String?, localSig: String?, remoteSig: String?) =
        BaseEntry(hash = hash, remoteHash = hash, localSig = localSig, remoteSig = remoteSig)

    private fun plan(
        local: Map<String, FileStat>,
        remote: Map<String, FileStat>,
        baseline: Map<String, BaseEntry>,
        localHashes: Map<String, String?> = emptyMap(),
        remoteHashes: Map<String, String?> = emptyMap(),
    ): List<Entry> = resolvePlan(quickPlan(local, remote, baseline), localHashes, remoteHashes)

    @Test
    fun `只在本地有则上传`() {
        val entry = plan(mapOf("a.txt" to stat(10, 100)), emptyMap(), emptyMap()).single()
        assertEquals(Kind.NEW_LOCAL, entry.kind)
        assertEquals(Action.UPLOAD, entry.action)
    }

    @Test
    fun `只在远端有则下载`() {
        val entry = plan(emptyMap(), mapOf("a.txt" to stat(10, 100)), emptyMap()).single()
        assertEquals(Kind.NEW_REMOTE, entry.kind)
        assertEquals(Action.DOWNLOAD, entry.action)
    }

    @Test
    fun `首次同步签名相同视为一致`() {
        val s = stat(10, 100)
        val entries = quickPlan(mapOf("a.txt" to s), mapOf("a.txt" to s), emptyMap())
        assertEquals(true, entries.single().needLocalHash)
        val entry = resolvePlan(entries, mapOf("a.txt" to "h1"), emptyMap()).single()
        assertEquals(Kind.SAME, entry.kind)
        assertEquals(Action.NONE, entry.action)
    }

    @Test
    fun `首次同步内容不同是冲突且没有默认动作`() {
        val entry = plan(
            mapOf("a.txt" to stat(10, 100)),
            mapOf("a.txt" to stat(11, 200)),
            emptyMap(),
            mapOf("a.txt" to "h1"),
            mapOf("a.txt" to "h2"),
        ).single()
        assertEquals(Kind.CONFLICT_ADD, entry.kind)
        assertEquals(Action.NONE, entry.action)
    }

    @Test
    fun `只有时间戳变化不算修改`() {
        val entry = plan(
            mapOf("a.txt" to stat(10, 555)),
            mapOf("a.txt" to stat(10, 100)),
            mapOf("a.txt" to base("h1", "10:100", "10:100")),
            mapOf("a.txt" to "h1"),
        ).single()
        assertEquals(Kind.SAME, entry.kind)
    }

    @Test
    fun `本地改内容则上传`() {
        val entry = plan(
            mapOf("a.txt" to stat(12, 555)),
            mapOf("a.txt" to stat(10, 100)),
            mapOf("a.txt" to base("h1", "10:100", "10:100")),
            mapOf("a.txt" to "h2"),
        ).single()
        assertEquals(Kind.MODIFIED_LOCAL, entry.kind)
        assertEquals(Action.UPLOAD, entry.action)
    }

    @Test
    fun `两端都改但内容一致不报冲突`() {
        val entry = plan(
            mapOf("a.txt" to stat(12, 111)),
            mapOf("a.txt" to stat(12, 222)),
            mapOf("a.txt" to base("h1", "10:100", "10:100")),
            mapOf("a.txt" to "h9"),
            mapOf("a.txt" to "h9"),
        ).single()
        assertEquals(Kind.SAME, entry.kind)
    }

    @Test
    fun `两端都改且内容不同是修改冲突`() {
        val entry = plan(
            mapOf("a.txt" to stat(13, 111)),
            mapOf("a.txt" to stat(14, 222)),
            mapOf("a.txt" to base("h1", "10:100", "10:100")),
            mapOf("a.txt" to "h2"),
            mapOf("a.txt" to "h3"),
        ).single()
        assertEquals(Kind.CONFLICT_MODIFY, entry.kind)
        assertEquals(Action.NONE, entry.action)
        assertEquals(1, summarize(listOf(entry)).pendingConflicts)
    }

    @Test
    fun `远端删除且本地未改则本地也删`() {
        val entry = plan(
            mapOf("a.txt" to stat(10, 100)),
            emptyMap(),
            mapOf("a.txt" to base("h1", "10:100", "10:100")),
        ).single()
        assertEquals(Kind.DELETED_REMOTE, entry.kind)
        assertEquals(Action.DELETE_LOCAL, entry.action)
    }

    @Test
    fun `远端删除但本地改过是冲突`() {
        val entry = plan(
            mapOf("a.txt" to stat(11, 777)),
            emptyMap(),
            mapOf("a.txt" to base("h1", "10:100", "10:100")),
            mapOf("a.txt" to "h2"),
        ).single()
        assertEquals(Kind.CONFLICT_DELETE_MODIFY, entry.kind)
        assertEquals("local", entry.survivor)
        assertEquals(Action.NONE, entry.action)
    }

    @Test
    fun `两端都删了只清基线`() {
        val entry = plan(emptyMap(), emptyMap(), mapOf("a.txt" to base("h1", "10:100", "10:100"))).single()
        assertEquals(Kind.BOTH_DELETED, entry.kind)
        assertEquals(Action.NONE, entry.action)
    }

    @Test
    fun `冲突选择三种口径`() {
        val entry = plan(
            mapOf("a.txt" to stat(13, 111)),
            mapOf("a.txt" to stat(14, 222)),
            mapOf("a.txt" to base("h1", "10:100", "10:100")),
            mapOf("a.txt" to "h2"),
            mapOf("a.txt" to "h3"),
        ).single()

        applyChoice(entry, "keep-local")
        assertEquals(Action.UPLOAD, entry.action)
        applyChoice(entry, "keep-remote")
        assertEquals(Action.DOWNLOAD, entry.action)
        applyChoice(entry, "keep-both")
        assertEquals(Action.KEEP_BOTH, entry.action)
        applyChoice(entry, "skip")
        assertEquals(Action.NONE, entry.action)
    }

    @Test
    fun `两个都留生成三步操作`() {
        val entry = plan(
            mapOf("dir/a.txt" to stat(13, 111)),
            mapOf("dir/a.txt" to stat(14, 222)),
            mapOf("dir/a.txt" to base("h1", "10:100", "10:100")),
            mapOf("dir/a.txt" to "h2"),
            mapOf("dir/a.txt" to "h3"),
        ).single()
        applyChoice(entry, "keep-both")
        val ops = expandOps(entry, allowDeletes = false, nowMillis = 0L)
        assertEquals(3, ops.size)
        assertEquals("copy-remote", ops[0].type)
        assertEquals("upload", ops[1].type)
        assertEquals("download", ops[2].type)
        assert(ops[0].to.contains("远端副本"))
    }

    @Test
    fun `删除操作默认被安全开关拦下`() {
        val entry = plan(
            emptyMap(),
            mapOf("a.txt" to stat(10, 100)),
            mapOf("a.txt" to base("h1", "10:100", "10:100")),
        ).single()
        assertEquals(0, expandOps(entry, allowDeletes = false, nowMillis = 0L).size)
        assertEquals(1, expandOps(entry, allowDeletes = true, nowMillis = 0L).size)
    }

    @Test
    fun `副本名保留扩展名且不含非法字符`() {
        val name = conflictCopyName("报告 v2.md", "远端副本", 0L)
        assertEquals(true, name.startsWith("报告 v2 (远端副本 "))
        assertEquals(true, name.endsWith(".md"))
        assertEquals(false, name.contains(":"))
        assertEquals(false, name.contains("*"))
    }

    @Test
    fun `摘要统计口径`() {
        val entries = plan(
            mapOf(
                "new.txt" to stat(100, 1),
                "changed.txt" to stat(1, 1),
                "same.txt" to stat(7, 3),
            ),
            mapOf(
                "changed.txt" to stat(200, 4),
                "same.txt" to stat(7, 3),
            ),
            mapOf(
                "changed.txt" to base("hm", "1:1", "1:1"),
                "same.txt" to base("hs", "7:3", "7:3"),
            ),
            mapOf("same.txt" to "hs"),
            mapOf("changed.txt" to "h9"),
        )
        val summary = summarize(entries)
        assertEquals(1, summary.upload)
        assertEquals(1, summary.download)
        assertEquals(100L, summary.bytesUp)
        assertEquals(200L, summary.bytesDown)
        assertEquals(0, summary.deletes)
    }

    @Test
    fun `空目录两端一致时不产生操作`() {
        val entries = plan(emptyMap(), emptyMap(), emptyMap())
        assertEquals(0, entries.size)
        assertEquals(0, summarize(entries).upload)
    }

    @Test
    fun `未知路径不会误判`() {
        val entry = plan(
            mapOf("a/b/c.txt" to stat(5, 9)),
            mapOf("a/b/c.txt" to stat(5, 9)),
            mapOf("a/b/c.txt" to base(null, "5:9", "5:9")),
        ).single()
        assertEquals(Kind.SAME, entry.kind)
        assertNull(entry.pendingReason)
        assertNotNull(entry.local)
    }
}
