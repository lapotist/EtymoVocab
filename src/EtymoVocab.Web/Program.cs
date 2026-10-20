using System.Runtime.Versioning;
using EtymoVocab.Core.Languages;
using EtymoVocab.Web;

[assembly: SupportedOSPlatform("browser")]

// The engine is driven from JavaScript (wwwroot/engine.js) through the exports in Engine.cs.
// Without ICU, string.Normalize is a no-op, so canonical composition uses the browser's implementation.
EntryNames.ComposeCanonical = BrowserText.NormalizeNfc;
