import AppKit
import Foundation

// ── Config — read from ~/.crewswarm at runtime ────────────────────────────────
func loadCrewConfig() -> [String: Any] {
    let path = (NSHomeDirectory() as NSString).appendingPathComponent(".crewswarm/config.json")
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let obj  = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return obj
}
func loadCrewSwarmJson() -> [String: Any] {
    let path = (NSHomeDirectory() as NSString).appendingPathComponent(".crewswarm/crewswarm.json")
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let obj  = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return obj
}

private let _cfg  = loadCrewConfig()
private let _csj  = loadCrewSwarmJson()
let DASH_PORT     = _cfg["dashPort"] as? Int ?? _csj["dashPort"] as? Int ?? 4319
let API_BASE      = "http://127.0.0.1:\(DASH_PORT)"
let SESSION       = "owner"
let FIRSTNAME     = _csj["firstName"] as? String
                 ?? _cfg["firstName"] as? String
                 ?? NSFullUserName().components(separatedBy: " ").first
                 ?? "there"

// ── Colors — matched exactly to dashboard CSS variables ───────────────────────
// --bg:#060a10  --bg-card:#0d1420  --accent:#38bdf8  --green:#34d399
// --text:#f0f6ff  --text-2:#8b9db3  --border:rgba(255,255,255,0.07)
extension NSColor {
    static let crewBg      = NSColor(red:0.024, green:0.039, blue:0.063, alpha:1) // #060a10
    static let crewCard    = NSColor(red:0.051, green:0.078, blue:0.125, alpha:1) // #0d1420
    static let crewUserBg  = NSColor(red:0.220, green:0.741, blue:0.973, alpha:1) // #38bdf8 accent
    static let crewText    = NSColor(red:0.941, green:0.965, blue:1.000, alpha:1) // #f0f6ff
    static let crewMuted   = NSColor(red:0.545, green:0.616, blue:0.702, alpha:1) // #8b9db3
    static let crewBorder  = NSColor.white.withAlphaComponent(0.07)
    static let crewBlue    = NSColor(red:0.220, green:0.741, blue:0.973, alpha:1) // #38bdf8
    static let crewGreen   = NSColor(red:0.204, green:0.827, blue:0.600, alpha:1) // #34d399
    static let crewRoadmap = NSColor(red:0.051, green:0.118, blue:0.220, alpha:1) // dark navy
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
func apiPost(_ path: String, body: [String:Any]) async -> [String:Any] {
    guard let url  = URL(string: API_BASE + path),
          let data = try? JSONSerialization.data(withJSONObject: body) else { return [:] }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody   = data
    req.timeoutInterval = 65
    do {
        let (d,_) = try await URLSession.shared.data(for: req)
        return (try? JSONSerialization.jsonObject(with: d) as? [String:Any]) ?? [:]
    } catch { return ["error": error.localizedDescription] }
}

func apiGet(_ path: String) async -> [String:Any] {
    guard let url = URL(string: API_BASE + path) else { return [:] }
    do {
        let (d,_) = try await URLSession.shared.data(from: url)
        return (try? JSONSerialization.jsonObject(with: d) as? [String:Any]) ?? [:]
    } catch { return [:] }
}

// ── SSE streaming delegate ────────────────────────────────────────────────────
// URLSessionDataTask completion handler fires ONCE when connection closes — useless for SSE.
// Instead we use URLSessionDataDelegate so didReceive fires as each chunk arrives.
class SSEDelegate: NSObject, URLSessionDataDelegate {
    var onEvent: (([String: Any]) -> Void)?
    private var buffer = ""

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let chunk = String(data: data, encoding: .utf8) else { return }
        buffer += chunk
        // Process complete SSE lines (terminated by \n\n)
        while let range = buffer.range(of: "\n\n") {
            let block = String(buffer[buffer.startIndex..<range.lowerBound])
            buffer = String(buffer[range.upperBound...])
            for line in block.components(separatedBy: "\n") {
                guard line.hasPrefix("data:") else { continue }
                let raw = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                guard !raw.isEmpty,
                      let d = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
                else { continue }
                DispatchQueue.main.async { self.onEvent?(d) }
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        // Connection dropped — will be restarted by AppDelegate
    }
}

// ── Floating window app (no menu bar icon — launched via SwiftBar) ────────────
class AppDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {

    var window: NSWindow!
    var scrollView: NSScrollView!
    var stack: NSStackView!
    var inputField: NSTextField!
    var sendBtn: NSButton!
    var sseTask: URLSessionDataTask?
    var sseSession: URLSession?
    var sseDelegate = SSEDelegate()
    var headerAgentLbl: NSTextField!
    var headerSubLbl: NSTextField!
    var headerDot: NSView!
    var pendingDraftId: String?
    var pendingProjectName: String?
    var pendingCardView: NSView?
    var lastAppendedAssistantContent: String = ""
    var lastAppendedUserContent: String = ""
    var projectPopUp: NSPopUpButton!
    var activeProjectId: String = ""
    var projectMap: [String: String] = [:] // title → id

    private let projectIdKey = "crewswarm_chat_active_project_id"

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.accessory) // no Dock icon
        buildWindow()
        loadAgentInfo()
        checkStatus()
        loadHistory()
        let savedId = UserDefaults.standard.string(forKey: projectIdKey) ?? ""
        loadProjects(autoSelectId: savedId.isEmpty ? nil : savedId)
        startSSE()
    }

    // Re-opened while already running (e.g. `open -a CrewChat` from SwiftBar)
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        bringToFront(); return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

    func bringToFront() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        inputField.window?.makeFirstResponder(inputField)
    }

    func buildWindow() {
        let W: CGFloat = 480, H: CGFloat = 640

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: W, height: H),
            styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = ""
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor.crewBg
        window.center()

        let root = window.contentView!
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor.crewBg.cgColor

        // ── Header bar ──────────────────────────────────────────────────
        let header = NSView()
        header.wantsLayer = true
        header.layer?.backgroundColor = NSColor.crewCard.cgColor
        header.layer?.borderColor = NSColor.crewBorder.cgColor
        header.layer?.borderWidth = 1
        header.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(header)

        headerAgentLbl = label("🧠  crew-lead", size: 13, color: .crewText, weight: .semibold)
        headerAgentLbl.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(headerAgentLbl)

        headerSubLbl = label("Conversational commander", size: 11, color: .crewMuted)
        headerSubLbl.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(headerSubLbl)

        // Status dot — right side, next to Clear
        headerDot = NSView()
        headerDot.wantsLayer = true
        headerDot.layer?.cornerRadius = 4
        headerDot.layer?.backgroundColor = NSColor.gray.cgColor
        headerDot.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(headerDot)

        let clearBtn = NSButton(title: "Clear", target: self, action: #selector(clearChat))
        clearBtn.isBordered = false
        clearBtn.wantsLayer = true
        clearBtn.layer?.cornerRadius = 6
        clearBtn.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.06).cgColor
        clearBtn.contentTintColor = .crewMuted
        clearBtn.font = .systemFont(ofSize: 11)
        clearBtn.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(clearBtn)

        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: root.topAnchor),
            header.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            header.heightAnchor.constraint(equalToConstant: 56),

            headerAgentLbl.centerXAnchor.constraint(equalTo: header.centerXAnchor),
            headerAgentLbl.topAnchor.constraint(equalTo: header.topAnchor, constant: 10),

            headerSubLbl.centerXAnchor.constraint(equalTo: header.centerXAnchor),
            headerSubLbl.topAnchor.constraint(equalTo: headerAgentLbl.bottomAnchor, constant: 2),

            clearBtn.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -14),
            clearBtn.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            clearBtn.widthAnchor.constraint(equalToConstant: 48),
            clearBtn.heightAnchor.constraint(equalToConstant: 26),

            // Dot sits left of Clear button
            headerDot.widthAnchor.constraint(equalToConstant: 8),
            headerDot.heightAnchor.constraint(equalToConstant: 8),
            headerDot.trailingAnchor.constraint(equalTo: clearBtn.leadingAnchor, constant: -10),
            headerDot.centerYAnchor.constraint(equalTo: header.centerYAnchor),
        ])

        stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment   = .leading
        stack.spacing     = 8
        stack.edgeInsets  = NSEdgeInsets(top:12, left:12, bottom:12, right:12)

        scrollView = NSScrollView()
        scrollView.documentView = stack
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.hasHorizontalScroller = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(scrollView)

        // ── Project selector bar ─────────────────────────────────────────
        let projectBar = NSView()
        projectBar.wantsLayer = true
        projectBar.layer?.backgroundColor = NSColor(red:0.04, green:0.06, blue:0.10, alpha:1).cgColor
        projectBar.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(projectBar)

        let projectLbl = label("Project:", size: 10, color: .crewMuted)
        projectLbl.translatesAutoresizingMaskIntoConstraints = false
        projectBar.addSubview(projectLbl)

        projectPopUp = NSPopUpButton()
        projectPopUp.isBordered = false
        projectPopUp.wantsLayer = true
        projectPopUp.layer?.cornerRadius = 6
        projectPopUp.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.04).cgColor
        projectPopUp.font = .systemFont(ofSize: 11)
        projectPopUp.contentTintColor = .crewMuted
        projectPopUp.target = self
        projectPopUp.action = #selector(projectChanged)
        projectPopUp.translatesAutoresizingMaskIntoConstraints = false
        projectBar.addSubview(projectPopUp)

        let openProjectsBtn = NSButton(title: "📁 Projects", target: self, action: #selector(openProjectsInBrowser))
        openProjectsBtn.isBordered = false
        openProjectsBtn.font = .systemFont(ofSize: 11)
        openProjectsBtn.contentTintColor = .crewMuted
        openProjectsBtn.toolTip = "Open Projects tab in dashboard (browser)"
        openProjectsBtn.translatesAutoresizingMaskIntoConstraints = false
        projectBar.addSubview(openProjectsBtn)

        let inputBar = NSView()
        inputBar.wantsLayer = true
        inputBar.layer?.backgroundColor = NSColor.crewCard.cgColor
        inputBar.layer?.borderColor     = NSColor.crewBorder.cgColor
        inputBar.layer?.borderWidth     = 1
        inputBar.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(inputBar)

        inputField = NSTextField()
        inputField.placeholderString = "Talk to crew-lead…  (Return to send)"
        inputField.isBordered  = false
        inputField.drawsBackground = false
        inputField.backgroundColor = .clear
        inputField.textColor = .crewText
        inputField.font = .systemFont(ofSize: 13)
        inputField.focusRingType = .none
        inputField.delegate = self
        inputField.translatesAutoresizingMaskIntoConstraints = false
        inputBar.addSubview(inputField)

        sendBtn = NSButton(title: "Send", target: self, action: #selector(sendMessage))
        sendBtn.isBordered = false
        sendBtn.wantsLayer = true
        sendBtn.layer?.cornerRadius = 8
        sendBtn.layer?.backgroundColor = NSColor.crewGreen.cgColor
        sendBtn.contentTintColor = .black
        sendBtn.font = .boldSystemFont(ofSize: 13)
        sendBtn.translatesAutoresizingMaskIntoConstraints = false
        inputBar.addSubview(sendBtn)

        NSLayoutConstraint.activate([
            // project bar sits above input bar
            projectBar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            projectBar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            projectBar.bottomAnchor.constraint(equalTo: inputBar.topAnchor),
            projectBar.heightAnchor.constraint(equalToConstant: 30),

            projectLbl.leadingAnchor.constraint(equalTo: projectBar.leadingAnchor, constant: 14),
            projectLbl.centerYAnchor.constraint(equalTo: projectBar.centerYAnchor),

            projectPopUp.leadingAnchor.constraint(equalTo: projectLbl.trailingAnchor, constant: 6),
            projectPopUp.centerYAnchor.constraint(equalTo: projectBar.centerYAnchor),
            projectPopUp.heightAnchor.constraint(equalToConstant: 22),

            openProjectsBtn.leadingAnchor.constraint(equalTo: projectPopUp.trailingAnchor, constant: 8),
            openProjectsBtn.trailingAnchor.constraint(equalTo: projectBar.trailingAnchor, constant: -10),
            openProjectsBtn.centerYAnchor.constraint(equalTo: projectBar.centerYAnchor),
            openProjectsBtn.widthAnchor.constraint(greaterThanOrEqualToConstant: 72),

            inputBar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            inputBar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            inputBar.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            inputBar.heightAnchor.constraint(equalToConstant: 56),

            inputField.leadingAnchor.constraint(equalTo: inputBar.leadingAnchor, constant: 16),
            inputField.centerYAnchor.constraint(equalTo: inputBar.centerYAnchor),
            inputField.trailingAnchor.constraint(equalTo: sendBtn.leadingAnchor, constant: -10),

            sendBtn.trailingAnchor.constraint(equalTo: inputBar.trailingAnchor, constant: -14),
            sendBtn.centerYAnchor.constraint(equalTo: inputBar.centerYAnchor),
            sendBtn.widthAnchor.constraint(equalToConstant: 64),
            sendBtn.heightAnchor.constraint(equalToConstant: 34),

            scrollView.topAnchor.constraint(equalTo: header.bottomAnchor),
            scrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: projectBar.topAnchor),

            stack.widthAnchor.constraint(equalTo: scrollView.widthAnchor),
        ])

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        addNote("Connected. Type anything to start.", color: .crewMuted)
    }

    // ── Bubble builders ───────────────────────────────────────────────────────
    @discardableResult
    func addBubble(_ text: String, isUser: Bool, from: String? = nil) -> NSView {
        let wrap = NSStackView()
        wrap.orientation = .vertical
        wrap.alignment   = isUser ? .trailing : .leading
        wrap.spacing     = 3

        if let f = from {
            let lbl = label(f, size:10, color:.crewMuted)
            wrap.addArrangedSubview(lbl)
        }

        let bubble = NSView()
        bubble.wantsLayer = true
        bubble.layer?.cornerRadius = 16
        if isUser {
            bubble.layer?.backgroundColor = NSColor.crewUserBg.cgColor
        } else {
            bubble.layer?.backgroundColor = NSColor.crewCard.cgColor
            bubble.layer?.borderColor = NSColor.crewBorder.cgColor
            bubble.layer?.borderWidth = 1
        }

        let tf = label(text, size:13, color: isUser ? NSColor(red:0.02, green:0.05, blue:0.10, alpha:1) : .crewText)
        tf.maximumNumberOfLines   = 0
        tf.lineBreakMode          = .byWordWrapping
        tf.preferredMaxLayoutWidth = 280
        tf.translatesAutoresizingMaskIntoConstraints = false
        bubble.addSubview(tf)
        NSLayoutConstraint.activate([
            tf.topAnchor.constraint(equalTo: bubble.topAnchor, constant: 9),
            tf.bottomAnchor.constraint(equalTo: bubble.bottomAnchor, constant: -9),
            tf.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 13),
            tf.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -13),
            tf.widthAnchor.constraint(lessThanOrEqualToConstant: 280),
        ])

        wrap.addArrangedSubview(bubble)
        if !isUser, let last = stack.arrangedSubviews.last as? NSStackView,
           last.arrangedSubviews.count >= 2,
           let lbl = last.arrangedSubviews.first as? NSTextField, lbl.stringValue.contains("crew-lead"),
           let bubbleView = last.arrangedSubviews.last?.subviews.first as? NSTextField,
           bubbleView.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) == text.trimmingCharacters(in: .whitespacesAndNewlines) {
            return wrap
        }
        addToStack(wrap)
        return wrap
    }

    func addNote(_ text: String, color: NSColor = .crewMuted) {
        let tf = label(text, size:11, color:color)
        tf.alignment = .center
        tf.translatesAutoresizingMaskIntoConstraints = false
        addToStack(tf)
        tf.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
    }

    func addRoadmapCard(_ draft: [String:Any]) {
        guard let draftId = draft["draftId"] as? String,
              let name    = draft["name"]    as? String,
              let outDir  = draft["outputDir"] as? String,
              let mdText  = draft["roadmapMd"] as? String else { return }

        pendingDraftId      = draftId
        pendingProjectName  = name

        let card = NSView()
        card.wantsLayer = true
        card.layer?.cornerRadius     = 12
        card.layer?.backgroundColor  = NSColor.crewRoadmap.cgColor
        card.layer?.borderColor      = NSColor(red:0.12,green:0.23,blue:0.43,alpha:1).cgColor
        card.layer?.borderWidth      = 1

        let tasks   = mdText.components(separatedBy:"\n").filter { $0.hasPrefix("- [ ]") }
        let preview = tasks.prefix(10).map { "  " + $0 }.joined(separator:"\n")

        let inner = NSStackView()
        inner.orientation = .vertical
        inner.alignment   = .leading
        inner.spacing     = 6
        inner.translatesAutoresizingMaskIntoConstraints = false

        inner.addArrangedSubview(label("🚀  " + name, size:13, color:.crewBlue, weight:.semibold))
        inner.addArrangedSubview(label(outDir, size:10, color:.crewMuted))
        inner.addArrangedSubview(label("\(tasks.count) tasks planned", size:10, color:.crewMuted))

        if !preview.isEmpty {
            let pv = label(preview, size:11, color:.crewText)
            pv.maximumNumberOfLines = 0
            pv.font = .monospacedSystemFont(ofSize:11, weight:.regular)
            pv.preferredMaxLayoutWidth = 320
            inner.addArrangedSubview(pv)
        }

        let btnRow = NSStackView()
        btnRow.spacing = 8

        let goBtn = actionBtn("▶  Start Building", bg: .crewGreen, fg: .black)
        goBtn.target = self; goBtn.action = #selector(confirmProject)
        let noBtn = actionBtn("Discard", bg: NSColor(red:0.2,green:0.2,blue:0.25,alpha:1), fg: .crewMuted)
        noBtn.target = self; noBtn.action = #selector(discardProject)
        btnRow.addArrangedSubview(goBtn)
        btnRow.addArrangedSubview(noBtn)

        inner.addArrangedSubview(btnRow)
        inner.addArrangedSubview(label("Or type 'go' to confirm", size:10, color:.crewMuted))

        card.addSubview(inner)
        NSLayoutConstraint.activate([
            inner.topAnchor.constraint(equalTo: card.topAnchor, constant:12),
            inner.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant:-12),
            inner.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant:12),
            inner.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant:-12),
        ])

        pendingCardView = card
        addToStack(card)
        card.translatesAutoresizingMaskIntoConstraints = false
        card.widthAnchor.constraint(equalTo: stack.widthAnchor, constant:-24).isActive = true
    }

    func addToStack(_ view: NSView) {
        view.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(view)
        if !(view is NSTextField) {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant:-24).isActive = true
        }
        scrollToBottom()
    }

    // ── Send / confirm / discard ──────────────────────────────────────────────
    @objc func sendMessage() {
        let text = inputField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        inputField.stringValue = ""

        let lower = text.lowercased()
        if pendingDraftId != nil && (lower == "go" || lower == "yes" || lower == "start") {
            Task { await doConfirm() }; return
        }
        if pendingDraftId != nil && (lower == "no" || lower == "discard" || lower == "cancel") {
            Task { await doDiscard() }; return
        }
        if lower == "clear" { Task { await doClear() }; return }

        addBubble(text, isUser: true, from: "You")
        lastAppendedUserContent = text
        sendBtn.isEnabled = false

        Task {
            let typing = await MainActor.run { () -> NSTextField in
                let t = self.label("🧠  thinking…", size:12, color:.crewMuted)
                self.addToStack(t)
                return t
            }

            var chatBody: [String: Any] = ["message": text, "sessionId": SESSION, "firstName": FIRSTNAME]
            let pid = await MainActor.run { self.activeProjectId }
            if !pid.isEmpty { chatBody["projectId"] = pid }
            let result = await apiPost("/api/crew-lead/chat", body: chatBody)

            await MainActor.run {
                typing.removeFromSuperview()
                self.sendBtn.isEnabled = true
                if let reply = result["reply"] as? String, !reply.isEmpty {
                    if reply != self.lastAppendedAssistantContent {
                        self.addBubble(reply, isUser: false, from: "🧠 crew-lead")
                        self.lastAppendedAssistantContent = reply
                    }
                }
                if let d = result["dispatched"] as? [String:Any], let a = d["agent"] as? String {
                    self.addNote("⚡ Dispatched to \(a)", color: .crewBlue)
                }
                if let p = result["pendingProject"] as? [String:Any] {
                    self.addRoadmapCard(p)
                }
                if result["reply"] == nil && result["error"] != nil {
                    self.addBubble("⚠️ crew-lead is offline", isUser: false)
                    self.sendBtn.isEnabled = true
                }
            }
        }
    }

    @objc func confirmProject() { Task { await doConfirm() } }
    @objc func discardProject() { Task { await doDiscard() } }
    @objc func clearChat()      { Task { await doClear()   } }

    func doConfirm() async {
        guard let id = pendingDraftId, let name = pendingProjectName else { return }
        await MainActor.run { addNote("Launching \(name)…") }
        let r = await apiPost("/api/crew-lead/confirm-project", body: ["draftId": id])
        await MainActor.run {
            pendingDraftId = nil; pendingProjectName = nil
            if r["ok"] as? Bool == true {
                addNote("✅ \(name) — PM loop running! Open Projects tab.", color: .crewGreen)
            } else {
                addNote("⚠️ \(r["error"] as? String ?? "launch failed")", color: .red)
            }
        }
    }

    func doDiscard() async {
        guard let id = pendingDraftId else { return }
        _ = await apiPost("/api/crew-lead/discard-project", body: ["draftId": id])
        await MainActor.run {
            if let card = pendingCardView { card.removeFromSuperview(); pendingCardView = nil }
            pendingDraftId = nil
            pendingProjectName = nil
            addNote("Discarded", color: .crewMuted)
        }
    }

    func doClear() async {
        _ = await apiPost("/api/crew-lead/clear", body: ["sessionId": SESSION])
        await MainActor.run {
            for v in stack.arrangedSubviews { v.removeFromSuperview() }
            addNote("History cleared", color: .crewMuted)
        }
    }

    // ── Project selector ──────────────────────────────────────────────────────
    func loadProjects(autoSelectId: String?) {
        Task {
            let r = await apiGet("/api/projects")
            guard let projects = r["projects"] as? [[String:Any]] else { return }
            await MainActor.run {
                let prevId = autoSelectId ?? self.activeProjectId
                self.projectMap = [:]
                self.projectPopUp.removeAllItems()
                self.projectPopUp.addItem(withTitle: "— no project —")
                for p in projects {
                    guard let id = p["id"] as? String, let name = p["name"] as? String else { continue }
                    let folder = (p["outputDir"] as? String)?.split(separator: "/").last.map(String.init) ?? ""
                    let title = folder.isEmpty ? name : "\(name) (\(folder))"
                    self.projectPopUp.addItem(withTitle: title)
                    self.projectMap[title] = id
                }
                // Restore previously selected project if still present
                if !prevId.isEmpty, let title = self.projectMap.first(where: { $0.value == prevId })?.key {
                    self.projectPopUp.selectItem(withTitle: title)
                    self.activeProjectId = prevId
                    UserDefaults.standard.set(prevId, forKey: self.projectIdKey)
                } else {
                    self.projectPopUp.selectItem(at: 0)
                    self.activeProjectId = ""
                    UserDefaults.standard.removeObject(forKey: self.projectIdKey)
                }
            }
        }
    }

    @objc func projectChanged() {
        let title = projectPopUp.titleOfSelectedItem ?? ""
        activeProjectId = projectMap[title] ?? ""
        UserDefaults.standard.set(activeProjectId.isEmpty ? nil : activeProjectId, forKey: projectIdKey)
    }

    @objc func openProjectsInBrowser() {
        guard let url = URL(string: "\(API_BASE)/#projects") else { return }
        NSWorkspace.shared.open(url)
    }

    // ── Status / history ──────────────────────────────────────────────────────
    func checkStatus() {
        Task {
            let r = await apiGet("/api/crew-lead/status")
            let online = r["online"] as? Bool == true
            await MainActor.run {
                self.headerDot.layer?.backgroundColor = (online ? NSColor.crewGreen : NSColor.red).cgColor
                if !online { self.addNote("⚠️ crew-lead offline — start it first", color: .red) }
                self.sendBtn.isEnabled = online
            }
        }
    }

    func loadAgentInfo() {
        Task {
            let r = await apiGet("/api/agents-config")
            guard let agents = r["agents"] as? [[String:Any]],
                  let cl = agents.first(where: { $0["id"] as? String == "crew-lead" }) else { return }
            let name  = cl["name"]  as? String ?? "crew-lead"
            let emoji = cl["emoji"] as? String ?? "🧠"
            let theme = cl["theme"] as? String ?? "Conversational commander"
            await MainActor.run {
                self.headerAgentLbl.stringValue = emoji + "  " + name
                self.headerSubLbl.stringValue   = theme
            }
        }
    }

    func loadHistory() {
        Task {
            let r = await apiGet("/api/crew-lead/history?sessionId=\(SESSION)")
            guard let hist = r["history"] as? [[String:Any]] else { return }
            let recent = hist.filter { ($0["role"] as? String) != "system" }.suffix(8)
            guard !recent.isEmpty else { return }
            await MainActor.run {
                self.lastAppendedAssistantContent = ""
                self.lastAppendedUserContent = ""
                self.addNote("─── recent ───")
                for h in recent {
                    guard let role    = h["role"]    as? String,
                          let content = h["content"] as? String else { continue }
                    let preview = content.count > 300 ? String(content.prefix(300)) + "…" : content
                    self.addBubble(preview, isUser: role == "user", from: role == "user" ? "You" : "🧠 crew-lead")
                    if role == "assistant" { self.lastAppendedAssistantContent = content }
                    if role == "user" { self.lastAppendedUserContent = content }
                }
                self.addNote("─────────────")
            }
        }
    }

    // ── SSE — streaming via URLSessionDataDelegate ────────────────────────────
    // Note: URLSessionDataTask completion handler fires ONCE on close — wrong for SSE.
    // URLSessionDataDelegate.urlSession(_:dataTask:didReceive:) fires per chunk — correct.
    func startSSE() {
        guard let url = URL(string: "\(API_BASE)/api/crew-lead/events") else { return }
        sseTask?.cancel()
        sseSession?.invalidateAndCancel()

        sseDelegate.onEvent = { [weak self] d in self?.handleSSEEvent(d) }
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 3600
        config.timeoutIntervalForResource = 86400
        sseSession = URLSession(configuration: config, delegate: sseDelegate, delegateQueue: .main)
        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        sseTask = sseSession!.dataTask(with: req)
        sseTask?.resume()
    }

    func handleSSEEvent(_ d: [String: Any]) {
        if let type_ = d["type"] as? String {
            if type_ == "chat_message",
               let sessionId = d["sessionId"] as? String, sessionId == SESSION {
                let role    = d["role"]    as? String ?? ""
                let content = d["content"] as? String ?? ""
                if role == "user", content != lastAppendedUserContent {
                    addBubble(content, isUser: true, from: "You")
                    lastAppendedUserContent = content
                } else if role == "assistant", content != lastAppendedAssistantContent {
                    addBubble(content, isUser: false, from: "🧠 crew-lead")
                    lastAppendedAssistantContent = content
                }
                scrollToBottom()
            } else if type_ == "pending_project",
                      let sessionId = d["sessionId"] as? String, sessionId == SESSION,
                      let p = d["pendingProject"] as? [String: Any] {
                addRoadmapCard(p)
                scrollToBottom()
            } else if type_ == "project_launched",
                      let proj = d["project"] as? [String: Any],
                      let name = proj["name"] as? String {
                let newId = proj["projectId"] as? String ?? proj["id"] as? String
                addNote("🚀 \(name) launched — crew is building!", color: .crewBlue)
                loadProjects(autoSelectId: newId)
            } else if type_ == "draft_discarded",
                      let id = d["draftId"] as? String, id == pendingDraftId {
                pendingCardView?.removeFromSuperview(); pendingCardView = nil
                pendingDraftId = nil; pendingProjectName = nil
                addNote("Discarded (synced)", color: .crewMuted)
            }
        } else if let from = d["from"] as? String, let content = d["content"] as? String {
            let preview = content.count > 200 ? String(content.prefix(200)) + "…" : content
            addBubble("✅ \(from): \(preview)", isUser: false, from: "agent reply")
        }
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) { sendMessage(); return true }
        return false
    }

    func scrollToBottom() {
        func doScroll() {
            guard let docView = self.scrollView.documentView else { return }
            docView.layoutSubtreeIfNeeded()
            let clipH = self.scrollView.contentView.bounds.height
            let docH = docView.frame.height
            if docH <= clipH { return }
            // Per Apple: use documentView.scrollPoint. Non-flipped: (0,0) = bottom; flipped: (0, docH - clipH) = bottom.
            let point = NSPoint(
                x: 0,
                y: docView.isFlipped ? max(0, docH - clipH) : 0
            )
            docView.scroll(point)
            self.scrollView.reflectScrolledClipView(self.scrollView.contentView)
        }
        doScroll()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { doScroll() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2)  { doScroll() }
    }

    func label(_ text: String, size: CGFloat, color: NSColor, weight: NSFont.Weight = .regular) -> NSTextField {
        let tf = NSTextField(labelWithString: text)
        tf.font        = .systemFont(ofSize: size, weight: weight)
        tf.textColor   = color
        tf.isSelectable = true
        tf.drawsBackground = false
        tf.isBordered  = false
        return tf
    }

    func actionBtn(_ title: String, bg: NSColor, fg: NSColor) -> NSButton {
        let b = NSButton(title: title, target: nil, action: nil)
        b.isBordered = false
        b.wantsLayer = true
        b.layer?.cornerRadius = 8
        b.layer?.backgroundColor = bg.cgColor
        b.contentTintColor = fg
        b.font = .boldSystemFont(ofSize: 12)
        b.translatesAutoresizingMaskIntoConstraints = false
        b.heightAnchor.constraint(equalToConstant: 30).isActive = true
        b.widthAnchor.constraint(greaterThanOrEqualToConstant: 110).isActive = true
        return b
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
withExtendedLifetime(delegate) { app.run() }
