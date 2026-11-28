package com.weldsuite.weldhr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.weldsuite.core.LoadState
import org.weldsuite.core.api.ApiException

class HrAccessTest {
    @Test
    fun wildcardsMatchAsTheServerDoes() {
        assertTrue(HrAccess.matches("*", "weldhr:leave:read"))
        assertTrue(HrAccess.matches("leave:*", "leave:approve"))
        assertTrue(HrAccess.matches("weldhr:*", "weldhr:leave:read"))
        assertTrue(HrAccess.matches("*:read", "leave:read"))
        assertFalse(HrAccess.matches("*:read", "weldhr:leave:read"))
        assertFalse(HrAccess.matches("leave:read", "leave:approve"))
        assertFalse(HrAccess.matches("leave", "leave:read"))
    }

    @Test
    fun anEmployeeSeesOnlyMyHr() {
        val access = HrAccess.resolve(listOf("weldhr:employees:self"), emptyList())
        assertTrue(access.self)
        assertFalse(access.team)
        assertFalse(access.approveLeave)
    }

    @Test
    fun aManagerApprovesWithReadAndApprove() {
        val access = HrAccess.resolve(listOf("employees:self", "leave:read", "leave:approve", "declarations:read", "weldhr:attendance:read"), emptyList())
        assertTrue(access.approveLeave)
        assertTrue(access.leave)
        assertFalse(access.approveExpenses)
        assertTrue(access.attendance)
        assertTrue(access.team)
    }

    @Test
    fun aDenyWins() {
        val access = HrAccess.resolve(listOf("*"), listOf("leave:approve", "weldhr:employees:read"))
        assertTrue(access.self)
        assertFalse(access.approveLeave)
        assertFalse(access.directory)
        assertTrue(access.createAnnouncements)
    }

    private val ready = Me(Profile("e1", "Ann", "ann@example.com", null, null, null, null, "active", null, null, null, null), Features(true, false, true, true))

    @Test
    fun myHrNeedsAccessAndALinkedRecord() {
        assertEquals(SelfState.Loading, SelfState.of(LoadState(), LoadState()))
        assertEquals(SelfState.NoAccess, SelfState.of(LoadState(error = ApiException(403, "FORBIDDEN", null)), LoadState()))
        assertEquals(SelfState.NoAccess, SelfState.of(LoadState(error = ApiException(500, null, null)), LoadState(HrAccess.NONE)))
        assertTrue(SelfState.of(LoadState(error = ApiException(null, null, null)), LoadState(HrAccess(self = true))) is SelfState.Failed)
        assertEquals(SelfState.NotLinked, SelfState.of(LoadState(ready.copy(employee = null)), LoadState()))
        assertTrue(SelfState.of(LoadState(ready), LoadState()) is SelfState.Ready)
    }

    @Test
    fun tabsFollowThePermissions() {
        assertEquals(HrTabs(true, true, true, true), HrTabs.of(HrAccess.NONE, loading = true))
        assertEquals(HrTabs(false, false, false, false), HrTabs.of(HrAccess.NONE, loading = false))
        assertEquals(HrTabs(true, true, false, false), HrTabs.of(HrAccess(attendance = true, leave = true), loading = false))
    }

    @Test
    fun thePlusKeepsToWhatTheTabIsAbout() {
        val all = Features(true, false, true, true)
        val none = Features(true, false, false, false)
        assertEquals(null, AddMenus.forTab("home", all, HrAccess()))
        assertEquals(AddMenu(AddAction.REQUEST_SHIFT, emptyList(), direct = true), AddMenus.forTab("schedule", all, HrAccess()))
        assertEquals(AddMenu(AddAction.NEW_ANNOUNCEMENT, emptyList(), direct = true), AddMenus.forTab("announcements", all, HrAccess(createAnnouncements = true)))
        assertEquals(AddMenu(AddAction.PHOTO_RECEIPT, listOf(AddAction.UPLOAD_RECEIPT)), AddMenus.forTab("expenses", all, HrAccess()))
        assertEquals(AddMenu(AddAction.REQUEST_LEAVE, listOf(AddAction.REPORT_SICK)), AddMenus.forTab("absence", all, HrAccess()))
        assertEquals(AddMenu(AddAction.REPORT_SICK, emptyList()), AddMenus.forTab("absence", none, HrAccess()))
        assertEquals(
            AddMenu(AddAction.REQUEST_LEAVE, listOf(AddAction.REQUEST_SHIFT, AddAction.REPORT_SICK, AddAction.NEW_EXPENSE)),
            AddMenus.forTab("announcements", all, HrAccess()),
        )
        assertEquals(AddMenu(AddAction.REQUEST_SHIFT, listOf(AddAction.REPORT_SICK)), AddMenus.forTab("expenses", none, HrAccess()))
    }
}
