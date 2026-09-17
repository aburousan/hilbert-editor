//! "New Window" in the menu the Dock shows for a right-click on Hilbert's icon.
//!
//! AppKit asks the application delegate for that menu with
//! `applicationDockMenu:`. The delegate is the windowing layer's own class and
//! does not answer it, and Tauri offers no hook for one, so the method is added
//! to that class once the delegate exists, and only if nothing in the class
//! or its ancestors answers it already.

use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, NSObject, Sel};
use objc2::{MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
use objc2_foundation::{MainThreadMarker, NSString};

static OPEN_WINDOW: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

// The menu lives as long as the app, and AppKit only borrows it on each
// right-click. Kept as an address because a Retained is not Sync.
static MENU: OnceLock<usize> = OnceLock::new();

define_class!(
    // A menu item calls its action on a target object; this is that object.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "HilbertDockMenuTarget"]
    struct Target;

    impl Target {
        #[unsafe(method(newWindow:))]
        fn new_window(&self, _sender: Option<&AnyObject>) {
            if let Some(open) = OPEN_WINDOW.get() {
                open();
            }
        }
    }
);

unsafe extern "C-unwind" fn dock_menu(_this: *mut AnyObject, _cmd: Sel, _app: *mut AnyObject) -> *mut NSMenu {
    MENU.get().map_or(std::ptr::null_mut(), |menu| *menu as *mut NSMenu)
}

/// Call on the main thread after the app has launched.
pub fn install(open_window: impl Fn() + Send + Sync + 'static) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    let Some(delegate) = app.delegate() else { return };
    let delegate: &AnyObject = objc2::runtime::ProtocolObject::as_ref(&*delegate);
    let class: &AnyClass = delegate.class();
    // An inherited implementation would be overridden by adding one here.
    if class.responds_to(sel!(applicationDockMenu:)) || OPEN_WINDOW.set(Box::new(open_window)).is_err() {
        return;
    }

    let target: Retained<Target> = unsafe { msg_send![Target::alloc(mtm), init] };
    let item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str("New Window"),
            Some(sel!(newWindow:)),
            &NSString::from_str(""),
        )
    };
    // A menu item does not keep its target alive, so neither is ever released.
    unsafe { item.setTarget(Some(&target)) };
    std::mem::forget(target);
    let menu = NSMenu::new(mtm);
    menu.addItem(&item);
    let _ = MENU.set(Retained::into_raw(menu) as usize);

    // Returns an object, takes self, _cmd and the application.
    let added = unsafe {
        objc2::ffi::class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            sel!(applicationDockMenu:),
            std::mem::transmute::<unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut NSMenu, Imp>(dock_menu),
            c"@@:@".as_ptr(),
        )
    };
    if !added.as_bool() {
        eprintln!("dock menu: could not add the Dock menu to the app delegate");
    }
}
