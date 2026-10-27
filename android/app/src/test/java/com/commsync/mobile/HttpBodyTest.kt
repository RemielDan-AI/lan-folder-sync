package com.commsync.mobile

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayInputStream

/**
 * 请求体读取的回归测试。
 *
 * 真实踩过的坑：某个路由先把 body 读空、又按 Content-Length 去读同样长度，
 * 第二次永远等不到数据，连接挂住 —— 电脑端表现为"无法连接对端"，手机端却一切正常。
 * 现在规定一个请求只读一次 body，这些用例守住"精确读取 + 不多读"的语义。
 */
class HttpBodyTest {

    @Test
    fun `按长度精确读取`() {
        val payload = """{"folderId":"local"}""".toByteArray()
        val stream = ByteArrayInputStream(payload + "尾部多余数据".toByteArray())
        val read = HttpBody.readExact(stream, payload.size.toLong())
        assertArrayEquals(payload, read)
        // 只能读走声明的长度，不能把后面的字节一起吃掉
        assertEquals("尾部多余数据".toByteArray().size, stream.available())
    }

    @Test
    fun `长度为 0 时返回空数组且不读流`() {
        val stream = ByteArrayInputStream("abc".toByteArray())
        assertEquals(0, HttpBody.readExact(stream, 0).size)
        assertEquals(3, stream.available())
    }

    @Test
    fun `声明长度大于实际内容时返回已读到的部分`() {
        val stream = ByteArrayInputStream("abc".toByteArray())
        val read = HttpBody.readExact(stream, 100)
        assertEquals("abc", String(read, Charsets.UTF_8))
    }

    @Test
    fun `超过上限的 body 被丢弃并返回空`() {
        val stream = ByteArrayInputStream(ByteArray(100) { 1 })
        val read = HttpBody.readExact(stream, 100, limit = 10)
        assertEquals(0, read.size)
        // 丢弃之后流里应该没有剩余数据（不会污染下一个请求）
        assertEquals(0, stream.available())
    }
}
