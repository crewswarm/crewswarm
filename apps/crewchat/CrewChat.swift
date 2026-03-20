import AppKit
import Foundation
import AVFoundation

// ── Config — read from ~/.crewswarm at runtime ────────────────────────────────
func loadCrewConfig() -> [String: Any] {
    let path = (NSHomeDirectory() as NSString).appendingPathComponent(".crewswarm/crewswarm.json")
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
    static let crewCardAlt = NSColor(red:0.070, green:0.110, blue:0.176, alpha:1)
    static let crewCardSoft = NSColor(red:0.083, green:0.129, blue:0.192, alpha:1)
    static let crewUserBg  = NSColor(red:0.220, green:0.741, blue:0.973, alpha:1) // #38bdf8 accent
    static let crewText    = NSColor(red:0.941, green:0.965, blue:1.000, alpha:1) // #f0f6ff
    static let crewMuted   = NSColor(red:0.545, green:0.616, blue:0.702, alpha:1) // #8b9db3
    static let crewBorder  = NSColor.white.withAlphaComponent(0.07)
    static let crewBlue    = NSColor(red:0.220, green:0.741, blue:0.973, alpha:1) // #38bdf8
    static let crewGreen   = NSColor(red:0.204, green:0.827, blue:0.600, alpha:1) // #34d399
    static let crewBlueMuted = NSColor(red:0.455, green:0.768, blue:0.945, alpha:1)
    static let crewRoadmap = NSColor(red:0.051, green:0.118, blue:0.220, alpha:1) // dark navy
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
func getAuthHeaders() -> [String: String] {
    let cfg = loadCrewConfig()
    if let rt = cfg["rt"] as? [String: Any], let token = rt["authToken"] as? String {
        return ["Authorization": "Bearer \(token)"]
    }
    return [:]
}

func apiPost(_ path: String, body: [String:Any]) async -> [String:Any] {
    guard let url  = URL(string: API_BASE + path),
          let data = try? JSONSerialization.data(withJSONObject: body) else { return [:] }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    
    // Add auth headers
    for (key, val) in getAuthHeaders() {
        req.setValue(val, forHTTPHeaderField: key)
    }
    
    req.httpBody   = data
    req.timeoutInterval = 65
    do {
        let (d,_) = try await URLSession.shared.data(for: req)
        return (try? JSONSerialization.jsonObject(with: d) as? [String:Any]) ?? [:]
    } catch {
        if let urlError = error as? URLError,
           [.cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .notConnectedToInternet, .timedOut].contains(urlError.code) {
            return ["error": "dashboard unavailable at \(API_BASE)"]
        }
        return ["error": error.localizedDescription]
    }
}

func apiGet(_ path: String) async -> [String:Any] {
    guard let url = URL(string: API_BASE + path) else { return [:] }
    var req = URLRequest(url: url)
    
    // Add auth headers
    for (key, val) in getAuthHeaders() {
        req.setValue(val, forHTTPHeaderField: key)
    }
    
    do {
        let (d,_) = try await URLSession.shared.data(for: req)
        return (try? JSONSerialization.jsonObject(with: d) as? [String:Any]) ?? [:]
    } catch { return [:] }
}

func apiPostMultipart(_ path: String, audioData: Data) async -> [String:Any] {
    guard let url = URL(string: API_BASE + path) else { return [:] }
    
    let boundary = "Boundary-\(UUID().uuidString)"
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    
    // Add auth headers
    for (key, val) in getAuthHeaders() {
        req.setValue(val, forHTTPHeaderField: key)
    }
    
    var body = Data()
    body.append("--\(boundary)\r\n".data(using: .utf8)!)
    body.append("Content-Disposition: form-data; name=\"audio\"; filename=\"voice.m4a\"\r\n".data(using: .utf8)!)
    body.append("Content-Type: audio/m4a\r\n\r\n".data(using: .utf8)!)
    body.append(audioData)
    body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
    
    req.httpBody = body
    req.timeoutInterval = 30
    
    do {
        let (d,_) = try await URLSession.shared.data(for: req)
        return (try? JSONSerialization.jsonObject(with: d) as? [String:Any]) ?? [:]
    } catch { return ["error": error.localizedDescription] }
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

    var window: NSWindow?  // Changed from NSWindow! to NSWindow? for safer nil handling
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
    var lastSentUserContent: String = ""
    var projectPopUp: NSPopUpButton!
    var activeProjectId: String = ""
    var projectMap: [String: String] = [:] // title → id
    
    // Mode selector dropdown (replaces tabs + toggle)
    var modeSelector: NSPopUpButton!
    var modelSelector: NSPopUpButton!
    var selectedMode: String = "crew-lead" // "crew-lead", "cli:opencode", "cli:cursor", "agent:crew-coder"
    var selectedModel: String = "" // For CLI passthrough
    var agentList: [[String: Any]] = []
    
    // Multimodal properties
    var audioRecorder: AVAudioRecorder?
    var isRecording = false
    var imageBtn: NSButton!
    var voiceBtn: NSButton!
    var projectTabs: NSStackView!
    var projectTabsScrollView: NSScrollView!
    var statusBadgeLabel: NSTextField!
    var dashboardRefreshTimer: Timer?
    var dashboardOnline = false
    var availableModels: [[String: Any]] = []
    
    // Per-mode + per-project chat state
    var chatStateByContext: [String: [(text: String, isUser: Bool, from: String)]] = [:]
    // key = "mode:projectId"

    private let projectIdKey = "crewswarm_chat_active_project_id"
    private let modeKey = "crewswarm_chat_selected_mode"
    private let modelKey = "crewswarm_chat_selected_model"

    func scopedSessionId(for mode: String? = nil) -> String {
        let activeMode = mode ?? selectedMode
        if activeMode == "crew-lead" { return SESSION }
        let slug = activeMode
            .replacingOccurrences(of: "[^a-zA-Z0-9._-]", with: "_", options: .regularExpression)
        return "\(SESSION)__\(slug)"
    }

    func normalizedMessageText(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func shouldAppendAssistantMessage(_ text: String) -> Bool {
        let normalized = normalizedMessageText(text)
        guard !normalized.isEmpty else { return false }
        return normalized != normalizedMessageText(lastAppendedAssistantContent)
    }

    func recordAssistantMessage(_ text: String) {
        lastAppendedAssistantContent = normalizedMessageText(text)
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.accessory) // no Dock icon
        
        // Restore saved state
        selectedMode = UserDefaults.standard.string(forKey: modeKey) ?? "crew-lead"
        selectedModel = UserDefaults.standard.string(forKey: modelKey) ?? ""
        
        buildWindow()
        loadAgentInfo()
        loadAgentList() // Load all agents for dropdown
        loadAvailableModels()
        checkStatus()
        loadHistory()
        let savedId = UserDefaults.standard.string(forKey: projectIdKey) ?? ""
        loadProjects(autoSelectId: savedId.isEmpty ? nil : savedId)
        startDashboardRefreshLoop()
        startSSE()
    }

    // Re-opened while already running (e.g. `open -a crewchat` from SwiftBar)
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        bringToFront(); return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        dashboardRefreshTimer?.invalidate()
        dashboardRefreshTimer = nil
    }

    func bringToFront() {
        // CRITICAL FIX: Check if window exists before accessing
        // Prevents crash when dock icon clicked after window closed
        guard let window = window else {
            // Window was deallocated - recreate it
            buildWindow()
            return
        }
        
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        inputField.window?.makeFirstResponder(inputField)
    }

    func buildWindow() {
        let W: CGFloat = 520, H: CGFloat = 720

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: W, height: H),
            styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window!.title = ""
        window!.titleVisibility = .hidden
        window!.titlebarAppearsTransparent = true
        window!.isMovableByWindowBackground = true
        window!.backgroundColor = NSColor.crewBg
        window!.center()

        let root = window!.contentView!
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

        let appTitle = label("crewchat", size: 13, color: .crewBlueMuted, weight: .bold)
        appTitle.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(appTitle)

        headerAgentLbl = label("crew-lead", size: 18, color: .crewText, weight: .semibold)
        headerAgentLbl.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(headerAgentLbl)

        headerSubLbl = label("Smart routing across crewswarm agents and CLIs", size: 11, color: .crewMuted)
        headerSubLbl.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(headerSubLbl)

        // Status dot — right side
        headerDot = NSView()
        headerDot.wantsLayer = true
        headerDot.layer?.cornerRadius = 3
        headerDot.layer?.backgroundColor = NSColor.gray.cgColor
        headerDot.translatesAutoresizingMaskIntoConstraints = false
        
        let statusBadge = NSView()
        statusBadge.wantsLayer = true
        statusBadge.layer?.cornerRadius = 12
        statusBadge.layer?.backgroundColor = NSColor.crewCardSoft.cgColor
        statusBadge.layer?.borderColor = NSColor.crewBorder.cgColor
        statusBadge.layer?.borderWidth = 1
        statusBadge.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(statusBadge)
        statusBadge.addSubview(headerDot)

        statusBadgeLabel = label("Connecting", size: 11, color: .crewMuted, weight: .medium)
        statusBadgeLabel.translatesAutoresizingMaskIntoConstraints = false
        statusBadge.addSubview(statusBadgeLabel)

        let clearBtn = actionBtn("Clear Chat", bg: NSColor.white.withAlphaComponent(0.06), fg: .crewText)
        clearBtn.target = self
        clearBtn.action = #selector(clearChat)
        clearBtn.font = .systemFont(ofSize: 12, weight: .medium)
        clearBtn.layer?.cornerRadius = 10
        header.addSubview(clearBtn)

        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: root.topAnchor),
            header.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            header.heightAnchor.constraint(equalToConstant: 78),

            appTitle.centerXAnchor.constraint(equalTo: header.centerXAnchor),
            appTitle.topAnchor.constraint(equalTo: header.topAnchor, constant: 12),

            headerAgentLbl.centerXAnchor.constraint(equalTo: header.centerXAnchor),
            headerAgentLbl.topAnchor.constraint(equalTo: appTitle.bottomAnchor, constant: 4),

            headerSubLbl.centerXAnchor.constraint(equalTo: header.centerXAnchor),
            headerSubLbl.topAnchor.constraint(equalTo: headerAgentLbl.bottomAnchor, constant: 3),
            headerSubLbl.trailingAnchor.constraint(lessThanOrEqualTo: statusBadge.leadingAnchor, constant: -16),
            headerSubLbl.leadingAnchor.constraint(greaterThanOrEqualTo: header.leadingAnchor, constant: 16),

            clearBtn.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -14),
            clearBtn.topAnchor.constraint(equalTo: header.topAnchor, constant: 14),
            clearBtn.heightAnchor.constraint(equalToConstant: 32),

            statusBadge.trailingAnchor.constraint(equalTo: clearBtn.leadingAnchor, constant: -10),
            statusBadge.centerYAnchor.constraint(equalTo: clearBtn.centerYAnchor),
            statusBadge.heightAnchor.constraint(equalToConstant: 24),

            headerDot.widthAnchor.constraint(equalToConstant: 6),
            headerDot.heightAnchor.constraint(equalToConstant: 6),
            headerDot.leadingAnchor.constraint(equalTo: statusBadge.leadingAnchor, constant: 10),
            headerDot.centerYAnchor.constraint(equalTo: statusBadge.centerYAnchor),

            statusBadgeLabel.leadingAnchor.constraint(equalTo: headerDot.trailingAnchor, constant: 6),
            statusBadgeLabel.trailingAnchor.constraint(equalTo: statusBadge.trailingAnchor, constant: -10),
            statusBadgeLabel.centerYAnchor.constraint(equalTo: statusBadge.centerYAnchor),
        ])

        // ── Control strip ────────────────────────────────────────────────────
        let controlsCard = NSView()
        controlsCard.wantsLayer = true
        controlsCard.layer?.backgroundColor = NSColor.crewCardSoft.cgColor
        controlsCard.layer?.borderColor = NSColor.crewBorder.cgColor
        controlsCard.layer?.borderWidth = 1
        controlsCard.layer?.cornerRadius = 14
        controlsCard.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(controlsCard)

        let modeLabel = label("Mode", size: 11, color: .crewMuted, weight: .semibold)
        modeLabel.translatesAutoresizingMaskIntoConstraints = false
        controlsCard.addSubview(modeLabel)

        modeSelector = NSPopUpButton(frame: .zero, pullsDown: false)
        modeSelector.translatesAutoresizingMaskIntoConstraints = false
        modeSelector.target = self
        modeSelector.action = #selector(modeChanged)
        modeSelector.font = .systemFont(ofSize: 13, weight: .semibold)
        stylePopUpButton(modeSelector)
        controlsCard.addSubview(modeSelector)

        modelSelector = NSPopUpButton(frame: .zero, pullsDown: false)
        modelSelector.translatesAutoresizingMaskIntoConstraints = false
        modelSelector.target = self
        modelSelector.action = #selector(modelChanged)
        modelSelector.font = .systemFont(ofSize: 12, weight: .medium)
        modelSelector.isHidden = true
        stylePopUpButton(modelSelector)
        controlsCard.addSubview(modelSelector)

        let modelHint = pillLabel("CLI model", bg: NSColor.crewBlue.withAlphaComponent(0.14), fg: .crewBlueMuted)
        modelHint.translatesAutoresizingMaskIntoConstraints = false
        controlsCard.addSubview(modelHint)

        NSLayoutConstraint.activate([
            controlsCard.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 12),
            controlsCard.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            controlsCard.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            controlsCard.heightAnchor.constraint(equalToConstant: 54),

            modeLabel.leadingAnchor.constraint(equalTo: controlsCard.leadingAnchor, constant: 14),
            modeLabel.centerYAnchor.constraint(equalTo: controlsCard.centerYAnchor),

            modeSelector.leadingAnchor.constraint(equalTo: modeLabel.trailingAnchor, constant: 10),
            modeSelector.centerYAnchor.constraint(equalTo: controlsCard.centerYAnchor),
            modeSelector.widthAnchor.constraint(equalToConstant: 230),
            modeSelector.heightAnchor.constraint(equalToConstant: 32),

            modelHint.leadingAnchor.constraint(equalTo: modeSelector.trailingAnchor, constant: 12),
            modelHint.centerYAnchor.constraint(equalTo: controlsCard.centerYAnchor),

            modelSelector.leadingAnchor.constraint(equalTo: modelHint.trailingAnchor, constant: 8),
            modelSelector.trailingAnchor.constraint(equalTo: controlsCard.trailingAnchor, constant: -14),
            modelSelector.centerYAnchor.constraint(equalTo: controlsCard.centerYAnchor),
            modelSelector.widthAnchor.constraint(greaterThanOrEqualToConstant: 150),
            modelSelector.heightAnchor.constraint(equalToConstant: 32),
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

        // ── Project Tabs ──────────────────────────────────────────────────────
        let projectSection = NSView()
        projectSection.wantsLayer = true
        projectSection.layer?.backgroundColor = NSColor.crewCard.cgColor
        projectSection.layer?.borderColor = NSColor.crewBorder.cgColor
        projectSection.layer?.borderWidth = 1
        projectSection.layer?.cornerRadius = 14
        projectSection.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(projectSection)

        let projectSectionTitle = label("Project", size: 11, color: .crewMuted, weight: .semibold)
        projectSectionTitle.translatesAutoresizingMaskIntoConstraints = false
        projectSection.addSubview(projectSectionTitle)

        projectTabs = NSStackView()
        projectTabs.orientation = .horizontal
        projectTabs.alignment = .centerY
        projectTabs.spacing = 8
        projectTabs.wantsLayer = true
        projectTabs.layer?.backgroundColor = NSColor.clear.cgColor
        projectTabs.edgeInsets = NSEdgeInsets(top: 2, left: 8, bottom: 2, right: 8)
        projectTabs.translatesAutoresizingMaskIntoConstraints = false
        
        projectTabsScrollView = NSScrollView()
        projectTabsScrollView.drawsBackground = false
        projectTabsScrollView.hasVerticalScroller = false
        projectTabsScrollView.hasHorizontalScroller = true
        projectTabsScrollView.autohidesScrollers = true
        projectTabsScrollView.borderType = .noBorder
        projectTabsScrollView.translatesAutoresizingMaskIntoConstraints = false
        projectTabsScrollView.documentView = projectTabs
        projectSection.addSubview(projectTabsScrollView)
        
        // Add default "General" tab
        let generalTab = createTabButton("🏠 General", projectId: "")
        projectTabs.addArrangedSubview(generalTab)
        generalTab.state = .on  // Active by default

        let inputBar = NSView()
        inputBar.wantsLayer = true
        inputBar.layer?.backgroundColor = NSColor.crewCard.cgColor
        inputBar.layer?.borderColor     = NSColor.crewBorder.cgColor
        inputBar.layer?.borderWidth     = 1
        inputBar.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(inputBar)

        inputField = NSTextField()
        inputField.placeholderString = "Talk to crew-lead… ⌘/ for commands"
        inputField.isBordered  = false
        inputField.drawsBackground = false
        inputField.backgroundColor = .clear
        inputField.textColor = .crewText
        inputField.font = .systemFont(ofSize: 13)
        inputField.focusRingType = .none
        inputField.delegate = self
        inputField.translatesAutoresizingMaskIntoConstraints = false
        inputBar.addSubview(inputField)
        
        // ── Multimodal buttons ───────────────────────────────────────────────
        imageBtn = NSButton(title: "📷", target: self, action: #selector(pickImage))
        imageBtn.isBordered = false
        imageBtn.wantsLayer = true
        imageBtn.layer?.cornerRadius = 6
        imageBtn.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.06).cgColor
        imageBtn.contentTintColor = .crewMuted
        imageBtn.font = .systemFont(ofSize: 18)
        imageBtn.toolTip = "Attach image"
        imageBtn.translatesAutoresizingMaskIntoConstraints = false
        inputBar.addSubview(imageBtn)
        
        voiceBtn = NSButton(title: "🎤", target: self, action: #selector(toggleVoiceRecording))
        voiceBtn.isBordered = false
        voiceBtn.wantsLayer = true
        voiceBtn.layer?.cornerRadius = 6
        voiceBtn.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.06).cgColor
        voiceBtn.contentTintColor = .crewMuted
        voiceBtn.font = .systemFont(ofSize: 18)
        voiceBtn.toolTip = "Record voice"
        voiceBtn.translatesAutoresizingMaskIntoConstraints = false
        inputBar.addSubview(voiceBtn)

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
            projectSection.topAnchor.constraint(equalTo: controlsCard.bottomAnchor, constant: 10),
            projectSection.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            projectSection.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            projectSection.heightAnchor.constraint(equalToConstant: 54),

            projectSectionTitle.leadingAnchor.constraint(equalTo: projectSection.leadingAnchor, constant: 14),
            projectSectionTitle.centerYAnchor.constraint(equalTo: projectSection.centerYAnchor),

            projectTabs.heightAnchor.constraint(equalToConstant: 40),
            projectTabsScrollView.leadingAnchor.constraint(equalTo: projectSectionTitle.trailingAnchor, constant: 12),
            projectTabsScrollView.trailingAnchor.constraint(equalTo: projectSection.trailingAnchor, constant: -6),
            projectTabsScrollView.centerYAnchor.constraint(equalTo: projectSection.centerYAnchor),
            projectTabsScrollView.heightAnchor.constraint(equalToConstant: 46),

            inputBar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            inputBar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            inputBar.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            inputBar.heightAnchor.constraint(equalToConstant: 56),

            inputField.leadingAnchor.constraint(equalTo: inputBar.leadingAnchor, constant: 16),
            inputField.centerYAnchor.constraint(equalTo: inputBar.centerYAnchor),
            inputField.trailingAnchor.constraint(equalTo: imageBtn.leadingAnchor, constant: -8),
            
            imageBtn.centerYAnchor.constraint(equalTo: inputBar.centerYAnchor),
            imageBtn.widthAnchor.constraint(equalToConstant: 40),
            imageBtn.heightAnchor.constraint(equalToConstant: 34),
            imageBtn.trailingAnchor.constraint(equalTo: voiceBtn.leadingAnchor, constant: -6),
            
            voiceBtn.centerYAnchor.constraint(equalTo: inputBar.centerYAnchor),
            voiceBtn.widthAnchor.constraint(equalToConstant: 40),
            voiceBtn.heightAnchor.constraint(equalToConstant: 34),
            voiceBtn.trailingAnchor.constraint(equalTo: sendBtn.leadingAnchor, constant: -8),

            sendBtn.trailingAnchor.constraint(equalTo: inputBar.trailingAnchor, constant: -14),
            sendBtn.centerYAnchor.constraint(equalTo: inputBar.centerYAnchor),
            sendBtn.widthAnchor.constraint(equalToConstant: 64),
            sendBtn.heightAnchor.constraint(equalToConstant: 34),

            scrollView.topAnchor.constraint(equalTo: projectSection.bottomAnchor, constant: 8),
            scrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: inputBar.topAnchor),

            stack.widthAnchor.constraint(equalTo: scrollView.widthAnchor),
        ])

        window!.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        
        // Populate dropdowns after window is created
        populateModeDropdown()
        populateModelDropdown()
        
        addNote("Connected. Type anything to start.", color: .crewMuted)
    }

    // ── Bubble builders ───────────────────────────────────────────────────────
    @discardableResult
    func addBubble(_ text: String, isUser: Bool, from: String? = nil) -> NSView {
        let wrap = NSStackView()
        wrap.orientation = .vertical
        wrap.alignment   = isUser ? .trailing : .leading
        wrap.spacing     = 3
        wrap.identifier = NSUserInterfaceItemIdentifier(isUser ? "user" : "assistant")

        if let f = from {
            let lbl = label(f, size:10, color:.crewMuted)
            lbl.identifier = NSUserInterfaceItemIdentifier(f)
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
           normalizedMessageText(bubbleView.stringValue) == normalizedMessageText(text) {
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

        // Handle special commands
        if text == "/help" || text == "⌘/" {
            showHelp()
            return
        }
        
        // Handle CLI commands: /cli <command> or @@CLI <command>
        if text.hasPrefix("/cli ") || text.hasPrefix("@@CLI ") {
            let command = text.replacingOccurrences(of: "/cli ", with: "")
                             .replacingOccurrences(of: "@@CLI ", with: "")
            executeCLI(command)
            return
        }

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
        lastSentUserContent = text
        sendBtn.isEnabled = false

        Task {
            let typing = await MainActor.run { () -> NSTextField in
                let label = self.getModeLabel(self.selectedMode)
                let t = self.label("\(label)  thinking…", size:12, color:.crewMuted)
                self.addToStack(t)
                return t
            }

            let result: [String: Any]
            let mode = await MainActor.run { self.selectedMode }
            let model = await MainActor.run { self.selectedModel }
            let pid = await MainActor.run { self.activeProjectId }
            
            if mode == "crew-lead" {
                // Unified crew-lead chat path
                var chatBody: [String: Any] = [
                    "mode": "crew-lead",
                    "message": text,
                    "sessionId": self.scopedSessionId(for: mode),
                    "firstName": FIRSTNAME
                ]
                if !pid.isEmpty { chatBody["projectId"] = pid }
                result = await apiPost("/api/chat/unified", body: chatBody)
            } else if mode.hasPrefix("cli:") {
                // Direct CLI bypass
                let engine = mode.replacingOccurrences(of: "cli:", with: "")
                var cliBody: [String: Any] = [
                    "engine": engine,
                    "message": text,
                    "sessionId": self.scopedSessionId(for: mode)
                ]
                if !model.isEmpty { cliBody["model"] = model }
                if !pid.isEmpty { cliBody["projectId"] = pid }
                result = await apiPost("/api/cli/chat", body: cliBody)
            } else {
                // Unified direct agent mode
                let agentId = mode.replacingOccurrences(of: "agent:", with: "")
                var body: [String: Any] = [
                    "mode": "agent",
                    "agentId": agentId,
                    "message": text,
                    "sessionId": self.scopedSessionId(for: mode)
                ]
                if !pid.isEmpty { body["projectId"] = pid }
                result = await apiPost("/api/chat/unified", body: body)
            }

            await MainActor.run {
                typing.removeFromSuperview()
                self.sendBtn.isEnabled = true
                
                let modeLabel = self.getModeLabel(self.selectedMode)
                
                // SSE usually delivers the reply first; HTTP reply is a fallback.
                // Delay briefly to let SSE dedup take effect, preventing double bubbles.
                let replyText = (result["reply"] as? String) ?? (result["output"] as? String) ?? ""
                if !replyText.isEmpty {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        if self.shouldAppendAssistantMessage(replyText) {
                            self.addBubble(replyText, isUser: false, from: modeLabel)
                            self.recordAssistantMessage(replyText)
                        }
                    }
                }
                
                if let d = result["dispatched"] as? [String:Any], let a = d["agent"] as? String {
                    self.addNote("⚡ Dispatched to \(a)", color: .crewBlue)
                }
                if let p = result["pendingProject"] as? [String:Any] {
                    self.addRoadmapCard(p)
                }
                if result["reply"] == nil && result["output"] == nil && result["error"] != nil {
                    let errorMsg = result["error"] as? String ?? "offline"
                    self.addBubble("⚠️ Error: \(errorMsg)", isUser: false)
                    self.sendBtn.isEnabled = true
                }
            }
        }
    }
    
    func showHelp() {
        let helpText = """
        **crewchat commands:**
        
        **modes:**
        • Use the header dropdown to switch between crew-lead, direct CLIs, and specialist agents
        
        **CLI commands:**
        • `/cli <command>` - Run shell command
        • `@@CLI <command>` - Same as /cli
        
        **chat commands (dashboard format):**
        • `@@DISPATCH {"agent":"crew-X","task":"..."}` - Direct dispatch
        • `@@SKILL skill-name {"param":"value"}` - Run skill
        • `@@BRAIN fact text` - Save to memory
        • `@@MEMORY search "query"` - Search memory
        • `@@MEMORY stats` - Memory statistics
        • `@@WEB_SEARCH query` - Web search
        • `@@WEB_FETCH url` - Fetch URL
        • `@@READ_FILE /path` - Read file
        • `@@WRITE_FILE /path` - Write file
        
        **navigation:**
        • `clear` - Clear chat
        • `/help` or `⌘/` - Show this help
        
        **advanced mode:**
        Pick a direct CLI or specialist agent from the dropdown.
        Local app state is isolated per mode and project.
        """
        addNote(helpText, color: .crewText)
    }
    
    func executeCLI(_ command: String) {
        addBubble("/cli \(command)", isUser: true, from: "You")
        addNote("🔧 Executing command...", color: .crewBlue)
        
        Task {
            let result = await apiPost("/api/dispatch", body: [
                "agent": "crew-main",
                "task": "@@RUN_CMD \(command)",
                "sessionId": SESSION
            ])
            
            await MainActor.run {
                if let output = result["output"] as? String {
                    self.addBubble("```\n\(output)\n```", isUser: false, from: "💻 CLI")
                } else {
                    self.addNote("⚠️ Command failed or returned no output", color: .red)
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
        _ = await apiPost("/api/crew-lead/clear", body: ["sessionId": scopedSessionId(for: selectedMode)])
        await MainActor.run {
            for v in stack.arrangedSubviews { v.removeFromSuperview() }
            addNote("History cleared", color: .crewMuted)
        }
    }

    // ── Project tabs (replacing dropdown) ────────────────────────────────────
    func createTabButton(_ title: String, projectId: String) -> NSButton {
        let btn = NSButton(title: title, target: self, action: #selector(tabClicked(_:)))
        btn.setButtonType(.toggle)
        btn.isBordered = false
        btn.wantsLayer = true
        btn.layer?.cornerRadius = 14
        btn.font = .systemFont(ofSize: 12, weight: .semibold)
        btn.identifier = NSUserInterfaceItemIdentifier(projectId)
        btn.translatesAutoresizingMaskIntoConstraints = false
        btn.heightAnchor.constraint(equalToConstant: 28).isActive = true
        btn.widthAnchor.constraint(greaterThanOrEqualToConstant: 96).isActive = true
        styleProjectTabButton(btn, active: false)
        return btn
    }
    
    @objc func tabClicked(_ sender: NSButton) {
        // Save current chat state before switching
        saveChatState()
        
        // Deactivate all tabs
        for view in projectTabs.arrangedSubviews {
            guard let btn = view as? NSButton else { continue }
            btn.state = .off
            styleProjectTabButton(btn, active: false)
        }

        // Activate clicked tab
        sender.state = .on
        styleProjectTabButton(sender, active: true)

        // Update active project
        let oldProjectId = activeProjectId
        activeProjectId = sender.identifier?.rawValue ?? ""
        UserDefaults.standard.set(activeProjectId.isEmpty ? nil : activeProjectId, forKey: projectIdKey)

        // Clear chat and load project-specific history
        if activeProjectId != oldProjectId {
            clearChatUI()
            restoreChatState()
            addNote("📁 \(sender.title)", color: .crewBlue)
            loadHistory(forProject: activeProjectId, forAgent: "crew-lead")
        }
    }
    
    // ── DEPRECATED: Old agent tab functions (kept for compatibility) ───────────
    func createAgentTab(_ agentData: [String: Any]) -> NSButton {
        // No longer used - agents are in dropdown
        return NSButton()
    }
    
    @objc func agentTabClicked(_ sender: NSButton) {
        // No longer used - agents are in dropdown
    }
    
    @objc func toggleMode() {
        // No longer used - mode selection is via dropdown
    }
    
    func saveChatState() {
        var messages: [(text: String, isUser: Bool, from: String)] = []
        for view in stack.arrangedSubviews {
            if let stackView = view as? NSStackView,
               stackView.arrangedSubviews.count >= 2,
               let bubble = stackView.arrangedSubviews.last,
               let textField = bubble.subviews.first as? NSTextField {
                let text = textField.stringValue
                let isUser = stackView.identifier?.rawValue == "user"
                let from = (stackView.arrangedSubviews.first as? NSTextField)?.stringValue
                    ?? (isUser ? "You" : getModeLabel(selectedMode))
                messages.append((text, isUser, from))
            }
        }
        let contextKey = "\(selectedMode):\(activeProjectId)"
        chatStateByContext[contextKey] = messages
    }
    
    func clearChatUI() {
        for view in stack.arrangedSubviews {
            stack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
    }
    
    func restoreChatState() {
        let contextKey = "\(selectedMode):\(activeProjectId)"
        guard let messages = chatStateByContext[contextKey] else { return }
        for msg in messages {
            addBubble(msg.text, isUser: msg.isUser, from: msg.from)
        }
    }
    
    func getModeLabel(_ mode: String) -> String {
        if mode == "crew-lead" { return "🧠 crew-lead" }
        if mode.hasPrefix("cli:") {
            let cli = mode.replacingOccurrences(of: "cli:", with: "")
            return "⚡ \(cli)"
        }
        if mode.hasPrefix("agent:") {
            let agentId = mode.replacingOccurrences(of: "agent:", with: "")
            return getAgentEmoji(agentId) + " " + getAgentName(agentId)
        }
        return "🤖"
    }
    
    func loadProjects(autoSelectId: String?) {
        Task {
            let r = await apiGet("/api/projects")
            guard let projects = r["projects"] as? [[String:Any]] else { return }
            await MainActor.run {
                let prevId = autoSelectId ?? self.activeProjectId
                self.projectMap = [:]
                
                // Clear existing project tabs (keep General)
                while self.projectTabs.arrangedSubviews.count > 1 {
                    let view = self.projectTabs.arrangedSubviews.last!
                    self.projectTabs.removeArrangedSubview(view)
                    view.removeFromSuperview()
                }
                
                // Add project tabs
                for p in projects {
                    guard let id = p["id"] as? String, let name = p["name"] as? String else { continue }
                    let title = "📁 \(name)"
                    let tab = self.createTabButton(title, projectId: id)
                    self.projectTabs.addArrangedSubview(tab)
                    self.projectMap[id] = name
                }
                
                // Restore previously selected project
                if !prevId.isEmpty {
                    for view in self.projectTabs.arrangedSubviews {
                        guard let btn = view as? NSButton else { continue }
                        if btn.identifier?.rawValue == prevId {
                            self.tabClicked(btn)
                            break
                        }
                    }
                } else {
                    // Select General tab
                    if let generalTab = self.projectTabs.arrangedSubviews.first as? NSButton {
                        self.tabClicked(generalTab)
                    }
                }
            }
        }
    }
    
    // ── Multimodal Functions ──────────────────────────────────────────────────
    
    @objc func pickImage() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.image]
        panel.message = "Select an image to analyze"
        
        if panel.runModal() == .OK, let url = panel.url {
            Task {
                guard let data = try? Data(contentsOf: url) else {
                    await MainActor.run {
                        addNote("⚠️ Could not read image file", color: .red)
                    }
                    return
                }
                
                let base64 = data.base64EncodedString()
                let dataUri = "data:image/jpeg;base64,\(base64)"
                
                await MainActor.run {
                    addBubble("📷 [Image: \(url.lastPathComponent)]", isUser: true, from: "You")
                    addNote("🖼️ Analyzing image...", color: .crewBlue)
                }
                
                let result = await apiPost("/api/analyze-image", body: [
                    "image": dataUri,
                    "prompt": "Describe this image in detail. What do you see?"
                ])
                
                await MainActor.run {
                    if let analysis = result["result"] as? String {
                        addBubble("**Image Analysis:**\n\n\(analysis)", isUser: false, from: "🖼️ Vision")
                        // Pre-fill input for follow-up
                        inputField.stringValue = "I uploaded an image. Here's what it shows: \(analysis)\n\nWhat should we do with this?"
                    } else {
                        let error = result["error"] as? String ?? "Unknown error"
                        addNote("⚠️ Image analysis failed: \(error)", color: .red)
                    }
                }
            }
        }
    }
    
    @objc func toggleVoiceRecording() {
        if isRecording {
            // Stop recording
            audioRecorder?.stop()
            isRecording = false
            voiceBtn.title = "🎤"
            voiceBtn.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.06).cgColor
        } else {
            // Start recording
            let tempDir = FileManager.default.temporaryDirectory
            let audioURL = tempDir.appendingPathComponent("crewchat_voice_\(Date().timeIntervalSince1970).m4a")
            
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 16000,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
            ]
            
            do {
                audioRecorder = try AVAudioRecorder(url: audioURL, settings: settings)
                audioRecorder?.delegate = self
                audioRecorder?.record()
                isRecording = true
                voiceBtn.title = "⏹️"
                voiceBtn.layer?.backgroundColor = NSColor.systemRed.cgColor
                addNote("🎤 Recording... Click again to stop", color: .crewBlue)
            } catch {
                addNote("⚠️ Microphone error: \(error.localizedDescription)", color: .red)
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
                let wasOnline = self.dashboardOnline
                self.dashboardOnline = online
                self.headerDot.layer?.backgroundColor = (online ? NSColor.crewGreen : NSColor.red).cgColor
                self.statusBadgeLabel.stringValue = online ? "online" : "offline"
                self.statusBadgeLabel.textColor = online ? .crewText : .crewMuted
                if online && !wasOnline {
                    self.loadAgentList()
                    self.loadAvailableModels()
                    let savedId = UserDefaults.standard.string(forKey: self.projectIdKey) ?? ""
                    self.loadProjects(autoSelectId: savedId.isEmpty ? nil : savedId)
                }
                if !online && wasOnline {
                    self.addNote("⚠️ dashboard / crew-lead offline", color: .red)
                }
                self.sendBtn.isEnabled = online
            }
        }
    }

    func startDashboardRefreshLoop() {
        dashboardRefreshTimer?.invalidate()
        dashboardRefreshTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.checkStatus()
                if self.dashboardOnline {
                    if self.agentList.isEmpty {
                        self.loadAgentList()
                    }
                    if self.availableModels.isEmpty {
                        self.loadAvailableModels()
                    }
                    if self.projectTabs.arrangedSubviews.count <= 1 {
                        let savedId = UserDefaults.standard.string(forKey: self.projectIdKey) ?? ""
                        self.loadProjects(autoSelectId: savedId.isEmpty ? nil : savedId)
                }
            }
        }
        RunLoop.main.add(dashboardRefreshTimer!, forMode: .common)
    }

    func loadAgentInfo() {
        Task {
            let r = await apiGet("/api/agents-config")
            guard let agents = r["agents"] as? [[String:Any]],
                  let cl = agents.first(where: { $0["id"] as? String == "crew-lead" }) else { return }
            let name  = cl["name"]  as? String ?? "crew-lead"
            let theme = cl["theme"] as? String ?? "Conversational commander"
            await MainActor.run {
                self.headerAgentLbl.stringValue = name.lowercased()
                self.headerSubLbl.stringValue   = theme
            }
        }
    }

    func loadHistory(forProject projectId: String = "", forAgent agentId: String = "crew-lead") {
        Task {
            if !projectId.isEmpty {
                let encodedProjectId = projectId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? projectId
                let r = await apiGet("/api/crew-lead/project-messages?projectId=\(encodedProjectId)&limit=100")
                guard let messages = r["messages"] as? [[String: Any]] else { return }
                let recent = messages.suffix(20)
                guard !recent.isEmpty else { return }
                await MainActor.run {
                    self.lastAppendedAssistantContent = ""
                    self.lastAppendedUserContent = ""
                    self.addNote("─── project history ───")
                    for msg in recent {
                        guard let role = msg["role"] as? String,
                              let content = msg["content"] as? String else { continue }
                        let preview = content.count > 400 ? String(content.prefix(400)) + "…" : content
                        let fromLabel = self.messageSourceLabel(for: msg, fallbackRole: role)
                        self.addBubble(preview, isUser: role == "user", from: fromLabel)
                        if role == "assistant" { self.recordAssistantMessage(content) }
                        if role == "user" { self.lastAppendedUserContent = content }
                    }
                    self.addNote("────────────────────")
                }
                return
            }

            let sessionId = await MainActor.run { self.scopedSessionId(for: self.selectedMode) }
            let encodedSessionId = sessionId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? sessionId
            let r = await apiGet("/api/crew-lead/history?sessionId=\(encodedSessionId)")
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
                    let fromLabel = role == "user" ? "You" : self.getModeLabel(self.selectedMode)
                    self.addBubble(preview, isUser: role == "user", from: fromLabel)
                    if role == "assistant" { self.recordAssistantMessage(content) }
                    if role == "user" { self.lastAppendedUserContent = content }
                }
                self.addNote("─────────────")
            }
        }
    }
    
    func loadAgentList() {
        Task {
            let r = await apiGet("/api/agents-config")
            guard let agents = r["agents"] as? [[String:Any]] else { return }
            await MainActor.run {
                self.agentList = agents
                
                // Find the agents section in the dropdown (after tag 999)
                guard let menu = self.modeSelector.menu else { return }
                var insertIndex = 0
                for (idx, item) in menu.items.enumerated() {
                    if item.tag == 999 { // Agent header
                        insertIndex = idx + 1
                        break
                    }
                }
                
                // Remove old agent items (everything after the header)
                while insertIndex < menu.items.count {
                    menu.removeItem(at: insertIndex)
                }
                
                // Add all agents to dropdown
                for agent in agents {
                    guard let id = agent["id"] as? String else { continue }
                    let emoji = agent["emoji"] as? String ?? "🤖"
                    let name = agent["name"] as? String ?? id.replacingOccurrences(of: "crew-", with: "")
                    
                    let item = NSMenuItem(title: "\(emoji) \(name)", action: nil, keyEquivalent: "")
                    item.representedObject = "agent:\(id)"
                    menu.insertItem(item, at: insertIndex)
                    insertIndex += 1
                }
                
                // Reselect current mode
                self.selectMode(self.selectedMode)
            }
        }
    }
    
    // ── Dropdown population and handlers ──────────────────────────────────────
    func populateModeDropdown() {
        modeSelector.removeAllItems()
        
        // Crew Lead (default)
        modeSelector.addItem(withTitle: "🧠 Crew Lead (default)")
        modeSelector.lastItem?.representedObject = "crew-lead"
        
        // Direct CLIs section
        modeSelector.menu?.addItem(NSMenuItem.separator())
        let cliHeader = NSMenuItem(title: "───── Direct CLIs ─────", action: nil, keyEquivalent: "")
        cliHeader.isEnabled = false
        modeSelector.menu?.addItem(cliHeader)
        
        let clis = [
            ("⚡ OpenCode", "cli:opencode"),
            ("🖱 Cursor CLI", "cli:cursor"),
            ("🔧 Crew CLI", "cli:crew-cli"),
            ("🟣 Codex CLI", "cli:codex"),
            ("✨ Gemini CLI", "cli:gemini"),
            ("🤖 Claude Code", "cli:claude")
        ]
        for (title, value) in clis {
            modeSelector.addItem(withTitle: title)
            modeSelector.lastItem?.representedObject = value
        }
        
        // Agents section (will be populated by loadAgentList)
        modeSelector.menu?.addItem(NSMenuItem.separator())
        let agentHeader = NSMenuItem(title: "───── Agents ─────", action: nil, keyEquivalent: "")
        agentHeader.isEnabled = false
        agentHeader.tag = 999 // Mark for insertion point
        modeSelector.menu?.addItem(agentHeader)
        
        // Select saved mode
        selectMode(selectedMode)
    }
    
    func populateModelDropdown() {
        modelSelector.removeAllItems()
        modelSelector.addItem(withTitle: "Model: Default")
        modelSelector.lastItem?.representedObject = ""
        let models = filteredModels(for: selectedMode)
        if models.isEmpty {
            let fallbackModels = fallbackModels(for: selectedMode)
            for model in fallbackModels {
                modelSelector.addItem(withTitle: "Model: \(model)")
                modelSelector.lastItem?.representedObject = model
            }
        } else {
            for model in models.prefix(30) {
                let modelId = model["id"] as? String ?? model["model"] as? String ?? ""
                if modelId.isEmpty { continue }
                let displayName = model["name"] as? String ?? modelId
                modelSelector.addItem(withTitle: "Model: \(displayName)")
                modelSelector.lastItem?.representedObject = modelId
            }
        }

        if !selectedModel.isEmpty && !modelSelector.itemArray.contains(where: { $0.representedObject as? String == selectedModel }) {
            modelSelector.addItem(withTitle: "Model: \(selectedModel)")
            modelSelector.lastItem?.representedObject = selectedModel
        }

        selectModelValue(selectedModel)
    }
    
    func selectMode(_ mode: String) {
        for item in modeSelector.itemArray {
            if item.representedObject as? String == mode {
                modeSelector.select(item)
                updateUIForMode(mode)
                return
            }
        }
        // Default to crew-lead if not found
        modeSelector.selectItem(at: 0)
        updateUIForMode("crew-lead")
    }
    
    func updateUIForMode(_ mode: String) {
        // Show model selector only for CLI modes
        modelSelector.isHidden = !mode.hasPrefix("cli:")
        populateModelDropdown()
        
        // Update header based on mode
        if mode == "crew-lead" {
            headerAgentLbl.stringValue = "crew-lead"
            headerSubLbl.stringValue = "Conversational commander"
        } else if mode.hasPrefix("cli:") {
            let cliName = mode.replacingOccurrences(of: "cli:", with: "")
            headerAgentLbl.stringValue = "\(cliName) cli"
            headerSubLbl.stringValue = "Direct CLI bypass"
        } else if mode.hasPrefix("agent:") {
            let agentId = mode.replacingOccurrences(of: "agent:", with: "")
            if let agent = agentList.first(where: { $0["id"] as? String == agentId }) {
                let name = agent["name"] as? String ?? agentId
                let theme = agent["theme"] as? String ?? ""
                headerAgentLbl.stringValue = name.lowercased()
                headerSubLbl.stringValue = theme
            }
        }
    }
    
    @objc func modeChanged() {
        guard let selected = modeSelector.selectedItem,
              let mode = selected.representedObject as? String else { return }
        
        // Save current chat state
        saveChatState()
        
        // Update mode
        selectedMode = mode
        UserDefaults.standard.set(mode, forKey: modeKey)
        
        // Update UI
        updateUIForMode(mode)
        
        // Clear and restore chat for new mode
        clearChatUI()
        restoreChatState()

        let modeLabel = selected.title
        addNote("🔄 Switched to \(modeLabel)", color: .crewMuted)
        if chatStateByContext["\(selectedMode):\(activeProjectId)"] == nil {
            loadHistory(forProject: activeProjectId)
        }
    }
    
    @objc func modelChanged() {
        guard let selected = modelSelector.selectedItem,
              let model = selected.representedObject as? String else { return }
        
        selectedModel = model
        UserDefaults.standard.set(model, forKey: modelKey)
        
        if !model.isEmpty {
            addNote("🎯 Model: \(model)", color: .crewMuted)
        }
    }

    func loadAvailableModels() {
        Task {
            let r = await apiGet("/api/models")
            guard let models = r["models"] as? [[String: Any]] else { return }
            await MainActor.run {
                self.availableModels = models
                self.populateModelDropdown()
            }
        }
    }

    func filteredModels(for mode: String) -> [[String: Any]] {
        guard mode.hasPrefix("cli:") else { return [] }
        let engine = mode.replacingOccurrences(of: "cli:", with: "")

        func modelId(_ model: [String: Any]) -> String {
            (model["id"] as? String ?? model["model"] as? String ?? "").lowercased()
        }

        func providerId(_ model: [String: Any]) -> String {
            (model["provider"] as? String ?? "").lowercased()
        }

        func featured(_ model: [String: Any]) -> Bool {
            model["featured"] as? Bool == true
        }

        switch engine {
        case "claude":
            return availableModels.filter {
                let id = modelId($0)
                let provider = providerId($0)
                return provider == "anthropic" || id.contains("claude") || id.contains("sonnet") || id.contains("opus") || id.contains("haiku")
            }
        case "gemini":
            return availableModels.filter {
                let id = modelId($0)
                let provider = providerId($0)
                return provider == "google" || id.contains("gemini")
            }
        case "codex":
            return availableModels.filter {
                let id = modelId($0)
                let provider = providerId($0)
                return provider == "openai" || provider == "openai-local" || id.contains("codex") || id.contains("gpt-5")
            }
        case "opencode", "cursor", "crew-cli":
            let featuredModels = availableModels.filter { featured($0) }
            return featuredModels.isEmpty ? availableModels : featuredModels
        default:
            return availableModels
        }
    }

    func fallbackModels(for mode: String) -> [String] {
        switch mode {
        case "cli:claude":
            return ["claude-sonnet-4-5-20250929", "claude-opus-4-1-20250805"]
        case "cli:gemini":
            return ["models/gemini-2.5-flash", "models/gemini-2.5-pro"]
        case "cli:codex":
            return ["gpt-5-codex", "gpt-5.3-codex"]
        default:
            return ["grok-4-1-fast-reasoning", "deepseek-chat", "openai/gpt-5.3-codex", "models/gemini-2.5-flash"]
        }
    }

    func selectModelValue(_ model: String) {
        if model.isEmpty {
            modelSelector.selectItem(at: 0)
            return
        }
        for item in modelSelector.itemArray {
            if item.representedObject as? String == model {
                modelSelector.select(item)
                return
            }
        }
        modelSelector.selectItem(at: 0)
    }
    
    // Helper functions
    func getAgentName(_ agentId: String) -> String {
        if let agent = agentList.first(where: { $0["id"] as? String == agentId }),
           let name = agent["name"] as? String {
            return name
        }
        return agentId.replacingOccurrences(of: "crew-", with: "")
    }
    
    func getAgentEmoji(_ agentId: String) -> String {
        if let agent = agentList.first(where: { $0["id"] as? String == agentId }),
           let emoji = agent["emoji"] as? String {
            return emoji
        }
        return "🤖"
    }
    
    func getEngineLabel(_ agentData: [String: Any]) -> String {
        // Check for active engine indicators
        if agentData["useCursorCli"] as? Bool == true {
            return "Cursor CLI"
        } else if agentData["useClaudeCode"] as? Bool == true {
            return "Claude Code"
        } else if agentData["useCodex"] as? Bool == true {
            return "Codex CLI"
        } else if agentData["useGeminiCli"] as? Bool == true {
            return "Gemini CLI"
        } else if agentData["inOpenCode"] as? Bool == true {
            return "OpenCode"
        } else {
            return "Direct API"
        }
    }

    func messageSourceLabel(for message: [String: Any], fallbackRole role: String) -> String {
        if role == "user" {
            return "You"
        }
        let source = message["source"] as? String ?? ""
        let agent = message["agent"] as? String
        let sourceEmoji: [String: String] = [
            "dashboard": "💻",
            "cli": "⚡",
            "sub-agent": "👷",
            "agent": "🤖"
        ]
        let emoji = sourceEmoji[source] ?? "🧠"
        if let agent, !agent.isEmpty {
            return "\(emoji) \(agent)"
        }
        if !source.isEmpty {
            return "\(emoji) \(source)"
        }
        return "🧠 crew-lead"
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
        
        // Add auth headers
        for (key, val) in getAuthHeaders() {
            req.setValue(val, forHTTPHeaderField: key)
        }
        
        sseTask = sseSession!.dataTask(with: req)
        sseTask?.resume()
    }

    func handleSSEEvent(_ d: [String: Any]) {
        if let type_ = d["type"] as? String {
            if type_ == "chat_message",
               let sessionId = d["sessionId"] as? String, sessionId == SESSION {
                let role    = d["role"]    as? String ?? ""
                let content = d["content"] as? String ?? ""
                if role == "user" {
                    // Skip SSE echo of messages we sent locally
                    if content == lastSentUserContent {
                        lastSentUserContent = ""
                        return
                    }
                    guard content != lastAppendedUserContent else { return }
                    addBubble(content, isUser: true, from: "You")
                    lastAppendedUserContent = content
                } else if role == "assistant", shouldAppendAssistantMessage(content) {
                    addBubble(content, isUser: false, from: "🧠 crew-lead")
                    recordAssistantMessage(content)
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

    func stylePopUpButton(_ button: NSPopUpButton) {
        button.isBordered = false
        button.wantsLayer = true
        button.layer?.cornerRadius = 12
        button.layer?.backgroundColor = NSColor.crewBg.withAlphaComponent(0.85).cgColor
        button.layer?.borderColor = NSColor.crewBorder.cgColor
        button.layer?.borderWidth = 1
        button.contentTintColor = .crewText
    }

    func styleProjectTabButton(_ button: NSButton, active: Bool) {
        button.layer?.backgroundColor = (active ? NSColor.crewBlueMuted : NSColor.crewCardAlt).cgColor
        button.layer?.borderWidth = 1
        button.layer?.borderColor = (active ? NSColor.crewBlue.withAlphaComponent(0.95) : NSColor.crewBorder).cgColor
        button.contentTintColor = active ? .black : .crewText
        let textColor = active ? NSColor.black : NSColor.crewText
        button.attributedTitle = NSAttributedString(
            string: button.title,
            attributes: [
                .foregroundColor: textColor,
                .font: NSFont.systemFont(ofSize: 12, weight: .semibold)
            ]
        )
    }

    func pillLabel(_ text: String, bg: NSColor, fg: NSColor) -> NSView {
        let wrap = NSView()
        wrap.wantsLayer = true
        wrap.layer?.cornerRadius = 10
        wrap.layer?.backgroundColor = bg.cgColor
        wrap.translatesAutoresizingMaskIntoConstraints = false

        let tf = label(text, size: 10, color: fg, weight: .bold)
        tf.translatesAutoresizingMaskIntoConstraints = false
        wrap.addSubview(tf)

        NSLayoutConstraint.activate([
            tf.topAnchor.constraint(equalTo: wrap.topAnchor, constant: 4),
            tf.bottomAnchor.constraint(equalTo: wrap.bottomAnchor, constant: -4),
            tf.leadingAnchor.constraint(equalTo: wrap.leadingAnchor, constant: 8),
            tf.trailingAnchor.constraint(equalTo: wrap.trailingAnchor, constant: -8),
        ])

        return wrap
    }

    func selectorCard(title: String, subtitle: String) -> NSStackView {
        let card = NSStackView()
        card.orientation = .vertical
        card.spacing = 6
        card.edgeInsets = NSEdgeInsets(top: 10, left: 10, bottom: 10, right: 10)
        card.wantsLayer = true
        card.layer?.cornerRadius = 12
        card.layer?.backgroundColor = NSColor.crewCardSoft.cgColor
        card.layer?.borderColor = NSColor.crewBorder.cgColor
        card.layer?.borderWidth = 1
        card.translatesAutoresizingMaskIntoConstraints = false
        card.addArrangedSubview(label(title, size: 11, color: .crewText, weight: .semibold))
        card.addArrangedSubview(label(subtitle, size: 10, color: .crewMuted))
        return card
    }
}

// ── AVAudioRecorderDelegate ───────────────────────────────────────────────────
extension AppDelegate: AVAudioRecorderDelegate {
    func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        guard flag else {
            addNote("⚠️ Recording failed", color: .red)
            return
        }
        let url = recorder.url
        
        Task {
            guard let audioData = try? Data(contentsOf: url) else {
                await MainActor.run {
                    addNote("⚠️ Could not read audio file", color: .red)
                }
                return
            }
            
            let sizeKB = Double(audioData.count) / 1024.0
            await MainActor.run {
                addBubble("🎤 [Voice message - \(String(format: "%.1f", sizeKB)) KB]", isUser: true, from: "You")
                addNote("🎤 Transcribing voice...", color: .crewBlue)
            }
            
            let result = await apiPostMultipart("/api/transcribe-audio", audioData: audioData)
            
            await MainActor.run {
                if let transcription = result["transcription"] as? String, !transcription.isEmpty {
                    addBubble("**Transcription:**\n\n\"\(transcription)\"", isUser: false, from: "🎤 Whisper")
                    // Put transcription in input for user to edit/send
                    inputField.stringValue = transcription
                    inputField.window?.makeFirstResponder(inputField)
                } else {
                    let error = result["error"] as? String ?? "Empty transcription"
                    addNote("⚠️ Transcription failed: \(error)", color: .red)
                }
            }
            
            // Clean up temp file
            try? FileManager.default.removeItem(at: url)
        }
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
withExtendedLifetime(delegate) { app.run() }
