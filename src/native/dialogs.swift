import AppKit
import UniformTypeIdentifiers

@_cdecl("researchbunny_dialog")
public func researchbunnyDialog(_ input: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    let request = (try? JSONSerialization.jsonObject(with: Data(String(cString: input).utf8))) as? [String: Any] ?? [:]
    var paths = [String]()
    let show = {
        let panel: NSSavePanel
        if request["operation"] as? String == "open" {
            let open = NSOpenPanel()
            open.canChooseFiles = request["files"] as? Bool ?? true
            open.canChooseDirectories = request["folders"] as? Bool ?? false
            open.allowsMultipleSelection = request["multiple"] as? Bool ?? false
            open.resolvesAliases = true
            panel = open
        } else {
            panel = NSSavePanel()
            panel.nameFieldStringValue = request["name"] as? String ?? ""
        }
        panel.title = request["title"] as? String ?? "ResearchBunny"
        panel.canCreateDirectories = true
        if let types = request["extensions"] as? [String], !types.isEmpty {
            panel.allowedContentTypes = types.compactMap { UTType(filenameExtension: $0) }
        }
        if panel.runModal() == .OK {
            paths = ((panel as? NSOpenPanel)?.urls ?? [panel.url!]).map { $0.path }
        }
    }
    if Thread.isMainThread { show() } else { DispatchQueue.main.sync(execute: show) }
    let result = try! JSONSerialization.data(withJSONObject: ["paths": paths])
    return strdup(String(data: result, encoding: .utf8)!)
}
@_cdecl("researchbunny_free")
public func researchbunnyFree(_ buffer: UnsafeMutableRawPointer?) { free(buffer) }
