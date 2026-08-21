// sw-globals.d.ts — the three globals a SERVICE worker has that a plain worker
// does not.
//
// lib.webworker types `self` as WorkerGlobalScope, which is the generic worker
// scope. A service worker runs in ServiceWorkerGlobalScope, and `skipWaiting`,
// `clients` and `registration` are the members that differ. They are declared
// here rather than by re-typing `self` in the file, because re-typing `self`
// means editing a script whose only job is to unregister itself.
interface WorkerGlobalScope {
  skipWaiting(): Promise<void>;
  clients: Clients;
  registration: ServiceWorkerRegistration;
}
