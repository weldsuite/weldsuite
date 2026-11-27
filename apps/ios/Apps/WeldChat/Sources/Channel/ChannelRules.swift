import Foundation
import WeldCore

// The rules of the conversation screens, without the screens: who the
// mention picker offers, what a header says, who may rename or leave a
// channel, which call the header joins. Pure, so `ChannelRulesTests` covers them.

/// What kind of conversation a screen shows, from the channel's `type`.
enum ConversationKind: Equatable {
    case channel, privateChannel, dm, record

    init(type: String?) {
        switch type ?? "" {
        case "dm": self = .dm
        case "entity": self = .record
        case "private": self = .privateChannel
        default: self = .channel
        }
    }
}

/// Someone the mention picker offers: an agent in the channel, or a person.
struct MentionCandidate: Identifiable, Equatable {
    let userID: String
    var name: String
    var email: String?
    var picture: String?
    var isAgent: Bool
    var agentIcon: String?

    var id: String { userID }
}

/// What the caller may do in a channel's details, from their role in it.
struct ChannelPermissions: Equatable {
    var isOwner: Bool
    var canManage: Bool
    var canLeave: Bool

    var showActions: Bool { canManage || canLeave || isOwner }
}

enum ChannelRules {
    /// The mention picker shows at most this many agents, then this many people.
    static let mentionAgentLimit = 5
    static let mentionPeopleLimit = 8
    /// How long a jumped-to message stays tinted.
    static let jumpFlash: Duration = .milliseconds(1800)

    /// The channel's agents first, then the workspace's people; both matched
    /// on name or e-mail, case-insensitively. An empty query matches everyone.
    static func mentionCandidates(query: String, agents: [ChannelMemberInfo], people: [TeamMember]) -> [MentionCandidate] {
        let needle = query.lowercased()
        func matches(_ name: String?, _ email: String?) -> Bool {
            guard !needle.isEmpty else { return true }
            return (name?.lowercased().contains(needle) ?? false) || (email?.lowercased().contains(needle) ?? false)
        }
        let agentRows = agents
            .filter { $0.isAgent && $0.name != nil && matches($0.name, nil) }
            .prefix(mentionAgentLimit)
            .map { MentionCandidate(userID: $0.userID, name: $0.name ?? "", email: nil, picture: nil, isAgent: true, agentIcon: $0.agentIcon) }
        let peopleRows = people
            .filter { matches($0.name, $0.email) }
            .prefix(mentionPeopleLimit)
            .map { MentionCandidate(userID: $0.userID, name: $0.displayName, email: $0.email, picture: $0.picture, isAgent: false, agentIcon: nil) }
        return Array(agentRows) + Array(peopleRows)
    }

    /// Copy is offered for a message with text, not for one that is only a file or a voice note.
    static func canCopy(_ message: ChatMessage) -> Bool {
        !MentionText.stripFileTokens(message.content).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The text that is copied: mentions as `@Name`, inline files dropped.
    static func copyText(_ message: ChatMessage, names: [String: String]) -> String {
        MentionText.plainText(message.content, names: names).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Every photo of the conversation, oldest first, for the viewer.
    static func images(_ messages: [ChatMessage]) -> [ViewerImage] {
        var seen = Set<String>()
        var images: [ViewerImage] = []
        for message in MessageLayout.chronological(messages) {
            for attachment in message.attachments where attachment.isImage && !seen.contains(attachment.url) {
                seen.insert(attachment.url)
                images.append(ViewerImage(url: attachment.url, authorName: message.authorName, createdAt: message.createdAt))
            }
        }
        return images
    }

    /// The header's name: a record chat goes by its record; the tapped row's
    /// name covers the time until the channel loads.
    static func displayName(channel: ChatChannel?, routeName: String?) -> String {
        if let channel {
            let name = channel.isRecord
                ? RecordChatRules.name(entityDisplayName: channel.entityDisplayName, name: channel.name)
                : channel.name
            if !name.isEmpty { return name }
        }
        return routeName ?? ""
    }

    /// The composer's placeholder; neutral until the name is known.
    static func placeholder(kind: ConversationKind, name: String) -> String {
        if kind == .dm || name.isEmpty { return ChatStrings.composerMessageDm }
        if kind == .record { return ChatStrings.recordChatsMessagePlaceholder(name: name) }
        return ChatStrings.composerMessageChannel(name: name)
    }

    /// The empty conversation's first line.
    static func welcome(kind: ConversationKind, name: String) -> String {
        switch kind {
        case .dm: ChatStrings.channelDmConversation(name: name)
        case .record: ChatStrings.recordChatsWelcome(name: name)
        case .channel, .privateChannel: ChatStrings.channelWelcome(name: name)
        }
    }

    /// Owners and admins rename and delete; members other than the owner may leave.
    static func permissions(members: [ChannelMemberInfo], userID: String) -> ChannelPermissions {
        let role = members.first { $0.userID == userID }?.role
        let isOwner = role == "owner"
        return ChannelPermissions(
            isOwner: isOwner,
            canManage: role == "owner" || role == "admin",
            canLeave: role != nil && !isOwner
        )
    }

    /// A call running here that the person is not in: the header offers "Join".
    static func joinableCall(active: ActiveChannelCall?, inCallID: String?) -> ActiveChannelCall? {
        guard let active, active.callID != inCallID else { return nil }
        return active
    }

    /// Who the call screen shows: the person of a DM, a record chat's name, `#channel`.
    static func callPeer(kind: ConversationKind, name: String, picture: String?) -> CallPeer {
        switch kind {
        case .dm: CallPeer(name: name.isEmpty ? nil : name, avatar: picture, isDirect: true)
        case .record: CallPeer(name: name.isEmpty ? nil : name)
        case .channel, .privateChannel: CallPeer(name: name.isEmpty ? nil : "#\(name)")
        }
    }

    /// The other person of a 1:1 DM; failing that, the roster member with the DM's name.
    static func peerUserID(dm: DmConversation?, name: String, roster: [TeamMember]) -> String? {
        if let dm {
            if dm.isGroup { return nil }
            if let peer = dm.peerUserID { return peer }
        }
        guard !name.isEmpty else { return nil }
        return roster.first { $0.name == name }?.userID
    }

    /// The roster's membership status says whether the DM's person is around:
    /// "Active now" for an active member, "Offline" otherwise, nothing when unknown.
    static func presenceSubtitle(status: String?) -> String? {
        guard let status else { return nil }
        return status.uppercased() == "ACTIVE" ? ChatStrings.channelActiveNow : ChatStrings.channelOffline
    }

    /// Another pin fits.
    static func canPin(pinnedCount: Int) -> Bool {
        pinnedCount < ChatLogic.pinLimit
    }

    /// The people a channel invite offers: everyone in the workspace who isn't in it yet.
    static func invitable(roster: [TeamMember], memberIDs: Set<String>, search: String) -> [TeamMember] {
        let needle = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return roster.filter { person in
            guard !memberIDs.contains(person.userID) else { return false }
            guard !needle.isEmpty else { return true }
            return (person.name?.lowercased().contains(needle) ?? false) || (person.email?.lowercased().contains(needle) ?? false)
        }
    }
}
