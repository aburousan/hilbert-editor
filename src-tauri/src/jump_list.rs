//! "New Window" in the jump list Windows shows for a right-click on Hilbert's
//! taskbar button or Start menu entry.
//!
//! A jump list task is a shortcut to a program and its arguments. This one
//! starts Hilbert again with `--new-window`; that copy finds the running one,
//! hands it the flag and exits, and the running one opens the window.

use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize};
use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
    DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, SetCurrentProcessExplicitAppUserModelID,
    ShellLink,
};
use windows::core::{HSTRING, Interface};

pub fn claim_app_id(app_id: &str) {
    if let Err(e) = unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(app_id)) } {
        eprintln!("jump list: could not set the app ID: {e}");
    }
}

/// Writes the list on a thread of its own, so its COM apartment is its own too
/// and the shell's work stays off the thread that runs the windows.
pub fn install(app_id: &'static str) {
    std::thread::spawn(move || {
        if let Err(e) = unsafe { write_list(app_id) } {
            eprintln!("jump list: {e}");
        }
    });
}

unsafe fn write_list(app_id: &str) -> windows::core::Result<()> {
    let exe = std::env::current_exe().map_err(|e| windows::core::Error::new(windows::Win32::Foundation::E_FAIL, e.to_string()))?;
    let exe = HSTRING::from(exe.as_os_str());
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.ok()?;
    let written = unsafe {
        (|| {
            let list: ICustomDestinationList = CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
            list.SetAppID(&HSTRING::from(app_id))?;
            let mut slots = 0u32;
            let _removed: IObjectArray = list.BeginList(&mut slots)?;

            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(&exe)?;
            link.SetArguments(&HSTRING::from("--new-window"))?;
            link.SetIconLocation(&exe, 0)?;
            link.SetDescription(&HSTRING::from("Open another Hilbert window"))?;
            // A task shows its title, which lives in the link's properties
            // rather than in the link itself.
            let properties: IPropertyStore = link.cast()?;
            properties.SetValue(&PKEY_Title, &PROPVARIANT::from("New Window"))?;
            properties.Commit()?;

            let tasks: IObjectCollection = CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
            tasks.AddObject(&link)?;
            list.AddUserTasks(&tasks.cast::<IObjectArray>()?)?;
            list.CommitList()
        })()
    };
    unsafe { CoUninitialize() };
    written
}
