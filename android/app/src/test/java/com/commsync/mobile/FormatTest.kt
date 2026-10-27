package com.commsync.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 地址补全：用户只填 IP:端口，协议和端口自动补齐。
 * 这段逻辑独立于 Android API，所以能直接在 JVM 上验证。
 */
class FormatTest {

    @Test
    fun `只填 IP 自动补协议和默认端口`() {
        assertEquals("http://192.168.1.6:47800", normalizeBaseUrl("192.168.1.6"))
        assertEquals("http://10.0.0.5:47800", normalizeBaseUrl("10.0.0.5"))
    }

    @Test
    fun `带端口时保持原样`() {
        assertEquals("http://192.168.1.6:47800", normalizeBaseUrl("192.168.1.6:47800"))
        assertEquals("http://192.168.1.6:9000", normalizeBaseUrl("192.168.1.6:9000"))
    }

    @Test
    fun `带协议时不重复加`() {
        assertEquals("http://192.168.1.6:47800", normalizeBaseUrl("http://192.168.1.6"))
        assertEquals("https://192.168.1.6:8443", normalizeBaseUrl("https://192.168.1.6:8443"))
    }

    @Test
    fun `去掉尾部斜杠`() {
        assertEquals("http://192.168.1.6:47800", normalizeBaseUrl("http://192.168.1.6/"))
        assertEquals("http://192.168.1.6:47800", normalizeBaseUrl("http://192.168.1.6:47800/"))
    }

    @Test
    fun `两侧空格和中间空格都被忽略`() {
        assertEquals("http://192.168.1.6:47800", normalizeBaseUrl("  192.168.1.6  "))
        assertEquals("http://192.168.1.6:47800", normalizeBaseUrl(" 192.168.1.6 : 47800 "))
    }

    @Test
    fun `主机名也支持`() {
        assertEquals("http://desktop-mrgcocs:47800", normalizeBaseUrl("desktop-mrgcocs"))
        assertEquals("http://desktop.local:47800", normalizeBaseUrl("desktop.local"))
    }

    @Test
    fun `空输入返回空`() {
        assertEquals("", normalizeBaseUrl(""))
        assertEquals("", normalizeBaseUrl("   "))
    }

    @Test
    fun `自定义默认端口`() {
        assertEquals("http://192.168.1.6:8080", normalizeBaseUrl("192.168.1.6", 8080))
    }
}
