import AppKit
import Security
import UniformTypeIdentifiers

func reply(_ value: Any) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
    FileHandle.standardOutput.write(data)
}
func fail(_ status: OSStatus) -> Never {
    reply(["error": "Native operation failed", "status": Int(status)])
    exit(1)
}
let input = FileHandle.standardInput.readDataToEndOfFile()
let request = (try JSONSerialization.jsonObject(with: input)) as! [String: Any]
let operation = request["operation"] as! String
    let account = request["account"] as! String
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "app.researchbunny.desktop.credentials",
        kSecAttrAccount as String: account
    ]
    if operation == "read" {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        if status == errSecItemNotFound { reply(["value": NSNull()]) }
        else if status == errSecSuccess {
            reply(["value": String(data: result as! Data, encoding: .utf8)!])
        } else { fail(status) }
    } else if operation == "write" {
        let value = (request["value"] as! String).data(using: .utf8)!
        let update = [kSecValueData as String: value]
        var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = value
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }
        if status != errSecSuccess { fail(status) }
        reply(["ok": true])
    } else { fail(errSecParam) }
