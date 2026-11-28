package com.weldsuite.welddesk

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.weldsuite.api.welddesk.models.DeskConversationDetailResponse
import org.weldsuite.api.welddesk.models.DeskConversationList
import org.weldsuite.core.WeldJson
import java.time.Instant

/** The server's answers, as the generated client reads them, mapped to the app's models. */
class DeskRepositoryTest {
    private val list = """
        {"data":[{"id":"dconv_1","createdAt":"2026-11-27T08:00:00.000Z","updatedAt":"2026-11-27T09:00:00.000Z",
          "conversationNumber":42,"title":"Order","state":"open","channel":"messenger","visitorId":"vis_1",
          "name":"Ann","email":null,"contactId":null,"assigneeId":null,"priority":null,"tags":[],
          "waitingSince":"2026-11-27T08:30:00.000Z","lastMessageAt":"2026-11-27T08:30:00.000Z",
          "lastMessagePreview":"Where is my order?","isMajorIncident":false},
         {"id":"dconv_2","createdAt":"2026-11-26T08:00:00.000Z","updatedAt":"2026-11-26T09:00:00.000Z",
          "conversationNumber":43,"title":null,"state":"closed","channel":"telegram","visitorId":null,
          "name":null,"email":"c@example.test","contactId":null,"assigneeId":"user_1","priority":"high",
          "waitingSince":null,"lastMessageAt":null,"lastMessagePreview":null}],
         "pagination":{"totalCount":2,"hasMore":true,"cursor":"30"}}
    """.trimIndent()

    private val detail = """
        {"data":{"id":"dconv_1","createdAt":"2026-11-27T08:00:00.000Z","updatedAt":"2026-11-27T09:00:00.000Z",
          "conversationNumber":42,"title":null,"state":"open","channel":"email","name":null,"email":"a@b.test",
          "customFields":{},
          "messages":[
            {"id":"m1","createdAt":"2026-11-27T08:30:00.000Z","conversationId":"dconv_1","kind":"message",
             "body":null,"authorType":"visitor","authorId":"vis_1",
             "attachments":[{"name":"photo.png","url":"https://f.test/p.png","contentType":"image/png","filesize":2048,"width":640,"height":480},
                            {"name":"broken","contentType":"text/plain","filesize":null}],
             "metadata":null},
            {"id":"m2","createdAt":"2026-11-27T08:31:00.000Z","conversationId":"dconv_1","kind":"event",
             "body":null,"authorType":"system","authorId":null,"attachments":null,
             "metadata":{"eventType":"rated","rating":4,"ratingComment":null}}]}}
    """.trimIndent()

    @Test
    fun aPageOfTheInboxMapsEveryField() {
        val page = WeldJson.decodeFromString(DeskConversationList.serializer(), list)
        val first = DeskRepository.conversation(page.data[0])
        assertEquals(42, first.number)
        assertEquals(ConversationState.OPEN, first.state)
        assertEquals(DeskChannel.MESSENGER, first.channel)
        assertEquals(Instant.parse("2026-11-27T08:30:00Z"), first.waitingSince)
        assertEquals("Where is my order?", first.lastMessagePreview)
        val second = DeskRepository.conversation(page.data[1])
        assertEquals(ConversationState.CLOSED, second.state)
        assertEquals(DeskChannel.OTHER, second.channel)
        assertEquals("telegram", second.channelValue)
        assertEquals("user_1", second.assigneeId)
        assertNull(second.waitingSince)
        assertEquals("30", page.pagination.cursor)
    }

    @Test
    fun aThreadMapsMessagesAttachmentsAndEvents() {
        val detail = DeskRepository.detail(WeldJson.decodeFromString(DeskConversationDetailResponse.serializer(), detail).data)
        assertEquals("a@b.test", detail.conversation.email)
        val (photo, rated) = detail.messages
        assertEquals(AuthorType.VISITOR, photo.authorType)
        // An attachment without a URL can't be opened, so it's left out.
        assertEquals(listOf(Attachment("photo.png", "https://f.test/p.png", "image/png", 2048, 640.0, 480.0)), photo.attachments)
        assertEquals(MessageKind.EVENT, rated.kind)
        assertEquals("rated", rated.eventType)
        assertEquals(4, rated.rating)
    }

    @Test
    fun hubEventsCarryTheRecord() {
        val message = Json.parseToJsonElement(
            """{"id":"m3","createdAt":"2026-11-27T08:32:00.000Z","conversationId":"dconv_1","kind":"note","body":"VIP","authorType":"agent","authorId":"user_1","attachments":null,"metadata":null}""",
        )
        assertEquals(MessageKind.NOTE, DeskRepository.messageFromEvent(message)?.kind)
        assertNull(DeskRepository.messageFromEvent(JsonObject(emptyMap())))
        val conversation = Json.parseToJsonElement(
            """{"id":"dconv_1","createdAt":"2026-11-27T08:00:00Z","updatedAt":"2026-11-27T09:00:00Z","conversationNumber":42,"state":"closed","channel":"email"}""",
        )
        assertEquals(ConversationState.CLOSED, DeskRepository.conversationFromEvent(conversation)?.state)
        assertNull(DeskRepository.conversationFromEvent(message))
    }
}
