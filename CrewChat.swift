import AppKit
import Foundation

// ── Config ────────────────────────────────────────────────────────────────────
let API_BASE  = "http://127.0.0.1:4319"
let SESSION   = "owner"
let FIRSTNAME = "Jeff"

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

// ── Menu bar app: status item + popover ───────────────────────────────────────
class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate, NSTextFieldDelegate {

    var statusItem: NSStatusItem!
    var popover: NSPopover!
    var scrollView: NSScrollView!
    var stack: NSStackView!
    var inputField: NSTextField!
    var sendBtn: NSButton!
    var dotView: NSView!
    var sseTask: URLSessionDataTask?
    var pendingDraftId: String?
    var pendingProjectName: String?
    var pendingCardView: NSView?
    var lastAppendedAssistantContent: String = ""
    var lastAppendedUserContent: String = ""

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.accessory)
        setupStatusItem()
        buildPopoverContent()
        checkStatus()
        loadHistory()
        startSSE()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

    func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePopover)
        if #available(macOS 11.0, *) {
            let img = NSImage(systemSymbolName: "bubble.left.and.bubble.right.fill", accessibilityDescription: "CrewChat")
            img?.isTemplate = true
            statusItem.button?.image = img
        }
        if statusItem.button?.image == nil {
            statusItem.button?.image = makeStatusIcon()
        }
    }

    func makeStatusIcon() -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let img = NSImage(size: size)
        img.isTemplate = true
        img.lockFocus()
        NSColor.gray.setFill()
        NSBezierPath(ovalIn: NSRect(x: 2, y: 6, width: 6, height: 6)).fill()
        NSBezierPath(ovalIn: NSRect(x: 10, y: 6, width: 6, height: 6)).fill()
        img.unlockFocus()
        return img
    }

    @objc func togglePopover() {
        if popover.isShown {
            popover.performClose(nil)
        } else {
            showPopover()
        }
    }

    func showPopover() {
        guard let button = statusItem.button else { return }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        NSApp.activate(ignoringOtherApps: true)
        inputField.window?.makeFirstResponder(inputField)
        loadHistory()
    }

    func popoverDidClose(_ notification: Notification) { }

    func popoverWillClose(_ notification: Notification) {
        inputField.window?.makeFirstResponder(nil)
    }

    // ── Popover content (same UI as before, fixed size for menu bar) ──────────
    func buildPopoverContent() {
        let W = 380, H = 520

        popover = NSPopover()
        popover.behavior = .transient
        popover.animates = true
        popover.contentSize = NSSize(width: W, height: H)
        popover.delegate = self

        let vc = NSViewController()
        let root = NSView(frame: NSRect(x: 0, y: 0, width: W, height: H))
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor.crewBg.cgColor
        vc.view = root

        stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment   = .leading
        stack.spacing    = 8
        stack.edgeInsets = NSEdgeInsets(top:12, left:12, bottom:12, right:12)

        scrollView = NSScrollView()
        scrollView.documentView = stack
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.hasHorizontalScroller = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(scrollView)

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

        dotView = NSView()
        dotView.wantsLayer = true
        dotView.layer?.cornerRadius = 4
        dotView.layer?.backgroundColor = NSColor.gray.cgColor
        dotView.translatesAutoresizingMaskIntoConstraints = false

        NSLayoutConstraint.activate([
            inputBar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            inputBar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            inputBar.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            inputBar.heightAnchor.constraint(equalToConstant: 52),

            inputField.leadingAnchor.constraint(equalTo: inputBar.leadingAnchor, constant: 14),
            inputField.centerYAnchor.constraint(equalTo: inputBar.centerYAnchor),
            inputField.trailingAnchor.constraint(equalTo: sendBtn.leadingAnchor, constant: -10),

            sendBtn.trailingAnchor.constraint(equalTo: inputBar.trailingAnchor, constant: -12),
            sendBtn.centerYAnchor.constraint(equalTo: inputBar.centerYAnchor),
            sendBtn.widthAnchor.constraint(equalToConstant: 58),
            sendBtn.heightAnchor.constraint(equalToConstant: 32),

            scrollView.topAnchor.constraint(equalTo: root.topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: inputBar.topAnchor),

            stack.widthAnchor.constraint(equalTo: scrollView.widthAnchor),
        ])

        popover.contentViewController = vc
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
        bubble.layer?.cornerRadius = 14
        bubble.layer?.backgroundColor = (isUser ? NSColor.crewUserBg : NSColor.crewCard).cgColor
        if !isUser {
            bubble.layer?.borderColor = NSColor.crewBorder.cgColor
            bubble.layer?.borderWidth = 1
        }

        let tf = label(text, size:13, color: isUser ? .black : .crewText)
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

            let result = await apiPost("/api/crew-lead/chat",
                body: ["message": text, "sessionId": SESSION, "firstName": FIRSTNAME])

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

    // ── Status / history ──────────────────────────────────────────────────────
    func checkStatus() {
        Task {
            let r = await apiGet("/api/crew-lead/status")
            let online = r["online"] as? Bool == true
            await MainActor.run {
                self.dotView.layer?.backgroundColor = (online ? NSColor.crewGreen : .red).cgColor
                if !online { self.addNote("⚠️ crew-lead offline — start it first", color: .red) }
                self.sendBtn.isEnabled = online
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

    // ── SSE ───────────────────────────────────────────────────────────────────
    func startSSE() {
        guard let url = URL(string: "\(API_BASE)/api/crew-lead/events") else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 3600
        sseTask = URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let self = self, let data = data,
                  let text = String(data: data, encoding: .utf8) else { return }
            for line in text.components(separatedBy: "\n") {
                guard line.hasPrefix("data:") else { continue }
                let raw = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                guard let d = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String:Any] else { continue }
                DispatchQueue.main.async {
                    if let type_ = d["type"] as? String {
                        if type_ == "chat_message", let sessionId = d["sessionId"] as? String, sessionId == SESSION {
                            let role = d["role"] as? String
                            let content = d["content"] as? String ?? ""
                            if role == "user" {
                                if content != self.lastAppendedUserContent {
                                    self.addBubble(content, isUser: true, from: "You")
                                    self.lastAppendedUserContent = content
                                }
                            } else if role == "assistant" {
                                if content != self.lastAppendedAssistantContent {
                                    self.addBubble(content, isUser: false, from: "🧠 crew-lead")
                                    self.lastAppendedAssistantContent = content
                                }
                            }
                            self.scrollToBottom()
                        } else if type_ == "pending_project", let sessionId = d["sessionId"] as? String, sessionId == SESSION, let p = d["pendingProject"] as? [String:Any] {
                            self.addRoadmapCard(p)
                            self.scrollToBottom()
                        } else if type_ == "project_launched",
                           let proj = d["project"] as? [String:Any], let name = proj["name"] as? String {
                            self.addNote("🚀 \(name) launched — crew is building!", color: .crewBlue)
                        } else if type_ == "draft_discarded", let id = d["draftId"] as? String, id == self.pendingDraftId {
                            if let card = self.pendingCardView { card.removeFromSuperview(); self.pendingCardView = nil }
                            self.pendingDraftId = nil
                            self.pendingProjectName = nil
                            self.addNote("Discarded (synced)", color: .crewMuted)
                        }
                    } else if let from = d["from"] as? String, let content = d["content"] as? String {
                        let preview = content.count > 200 ? String(content.prefix(200)) + "…" : content
                        self.addBubble("✅ \(from): \(preview)", isUser: false, from: "agent reply")
                    }
                }
            }
        }
        sseTask?.resume()
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
