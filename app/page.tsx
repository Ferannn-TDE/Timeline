"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type SupabaseClient, type User } from "@supabase/supabase-js";
import DocsSync from "./docs-sync";
import { getJournalClient } from "@/lib/client";

import { APPROVED_EMAILS, addEntry, editEntry, deleteEntry, loadEntries, errorMessage, type Entry } from "@/lib/journal";

export default function Home(){
  const db = getJournalClient();
  const [googleReady,setGoogleReady]=useState(false),[providerChecked,setProviderChecked]=useState(false),[providerAvailable,setProviderAvailable]=useState(true);
  const [docsState,setDocsState]=useState("Google Docs not connected");
  const [user,setUser]=useState<User|null>(null),[checking,setChecking]=useState(true),[member,setMember]=useState(false);
  const [entries,setEntries]=useState<Entry[]>([]),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false);
  const [error,setError]=useState(""),[message,setMessage]=useState(""),[email,setEmail]=useState("");
  const [photo,setPhoto]=useState<File|null>(null),[preview,setPreview]=useState(""),[date,setDate]=useState(""),[caption,setCaption]=useState("");
  const [editing,setEditing]=useState<Entry|null>(null),[editDate,setEditDate]=useState(""),[editCaption,setEditCaption]=useState("");
  const input=useRef<HTMLInputElement>(null);
  const refreshVersion=useRef(0);
  const activeAccount=useRef<string|null>(null);

  const refresh=useCallback(async (client:SupabaseClient,account:User)=>{
    const version=++refreshVersion.current;
    const current=()=>version===refreshVersion.current && activeAccount.current===account.id;
    try{
      const {data:access,error:accessError}=await client.from("journal_members").select("email").eq("email",(account.email || "").toLowerCase()).maybeSingle();
      if(!current())return;
      if(accessError)throw accessError;
      if(!access || !APPROVED_EMAILS.includes((account.email || "").toLowerCase())){setMember(false);setEntries([]);return}
      setMember(true);setLoading(true);
      const loaded=await loadEntries(client);
      if(current()){setEntries(loaded);setError("")}
    }catch(e){if(current())setError(errorMessage(e,"Could not load entries."))}
    finally{if(current()){setChecking(false);setLoading(false)}}
  },[]);
  useEffect(()=>{
    if(!db){setChecking(false);return}
    let active=true;
    let authVersion=0;
    const hash=new URLSearchParams(window.location.hash.slice(1));
    const authError=hash.get("error_description") || new URLSearchParams(window.location.search).get("error_description");
    if(authError){setError(authError);window.history.replaceState(null,"",window.location.pathname)}
    db.auth.getUser().then(({data})=>{if(!active||authVersion!==0)return;activeAccount.current=data.user?.id || null;setUser(data.user);if(data.user)void refresh(db,data.user);else setChecking(false)}).catch(e=>{if(active&&authVersion===0){setError(errorMessage(e,"Could not check your sign-in."));setChecking(false)}});
    const {data:listener}=db.auth.onAuthStateChange((_event,session)=>{
      if(!active)return;
      ++authVersion;
      if(activeAccount.current!== (session?.user.id || null)){
        ++refreshVersion.current;setEntries([]);setMember(false);setEditing(null);setPhoto(null);setDate("");setCaption("");setMessage("");setLoading(false);setDocsState("Google Docs not connected");
      }
      activeAccount.current=session?.user.id || null;
      setUser(session?.user || null);
      if(session?.user)setTimeout(()=>{if(active)void refresh(db,session.user)},0);
      else{setEntries([]);setMember(false);setChecking(false)}
    });
    const poll=()=>{void db.auth.getUser().then(({data})=>{if(active && data.user && activeAccount.current===data.user.id)void refresh(db,data.user)}).catch(e=>{if(active)setError(errorMessage(e,"Could not refresh the timeline."))})};
    const timer=setInterval(poll,30000);
    const onVisible=()=>{if(document.visibilityState==="visible")poll()};
    document.addEventListener("visibilitychange",onVisible);
    return()=>{active=false;++refreshVersion.current;activeAccount.current=null;listener.subscription.unsubscribe();clearInterval(timer);document.removeEventListener("visibilitychange",onVisible)};
  },[db,refresh]);
  useEffect(()=>{let active=true;void fetch("/api/auth/providers",{cache:"no-store"}).then(r=>r.json()).then(data=>{if(active){setGoogleReady(data.google===true);setProviderAvailable(data.available!==false);setProviderChecked(true)}}).catch(()=>{if(active){setProviderAvailable(false);setProviderChecked(true)}});return()=>{active=false}},[]);
  async function signInGoogle(){if(!db||busy||!googleReady)return;setBusy(true);setError("");setMessage("");try{
    const {data,error:authError}=await db.auth.signInWithOAuth({provider:"google",options:{redirectTo:window.location.origin,queryParams:{prompt:"select_account",include_granted_scopes:"false"},skipBrowserRedirect:true}});
    if(authError)throw authError;if(!data.url)throw Error("Google sign-in could not start.");window.location.assign(data.url);
  }catch(e){setError(errorMessage(e,"Could not sign in with Google."));setBusy(false)}}
  useEffect(()=>{if(!photo){setPreview("");return}const local=URL.createObjectURL(photo);setPreview(local);return()=>URL.revokeObjectURL(local)},[photo]);
  async function signIn(e:React.FormEvent){e.preventDefault();if(!db||busy)return;setBusy(true);setError("");setMessage("");try{
    const normalizedEmail=email.trim().toLowerCase();
    if(!APPROVED_EMAILS.includes(normalizedEmail))throw Error("This journal is shared with its two approved editors only.");
    const {error:authError}=await db.auth.signInWithOtp({email:normalizedEmail,options:{emailRedirectTo:window.location.origin,shouldCreateUser:true}});
    if(authError)throw authError;setMessage("Check your email for a sign-in link.");
  }catch(e){setError(errorMessage(e,"Could not send the sign-in link."))}finally{setBusy(false)}}
  async function add(e:React.FormEvent){e.preventDefault();if(!db||!user||!photo||busy)return;setBusy(true);setError("");setMessage("");
    try{
      await addEntry(db,user.email || "",photo,date,caption);
      setPhoto(null);setDate("");setCaption("");if(input.current)input.current.value="";
      setMessage("Photo added in date order.");await refresh(db,user);
    }catch(e){setError(errorMessage(e,"Could not save photo."))}
    finally{setBusy(false)}
  }
  async function change(id:string){if(!db||!user||busy)return;setBusy(true);setError("");setMessage("");
    try{
      const original=editing?.id===id ? editing : null;
      if(!original)throw Error("This entry was removed. Refresh the timeline.");
      await editEntry(db,original,editDate,editCaption);
      setEditing(null);setMessage("Changes saved.");await refresh(db,user);
    }catch(e){setError(errorMessage(e,"Could not save changes."))}finally{setBusy(false)}
  }
  async function remove(entry:Entry){if(!db||!user||busy||!confirm("Remove this photo and caption?"))return;setBusy(true);setError("");setMessage("");
    try{
      const warning=await deleteEntry(db,entry);
      setEditing(null);setMessage(warning || "Entry removed.");await refresh(db,user);
    }catch(e){setError(errorMessage(e,"Could not remove entry."))}finally{setBusy(false)}
  }
  async function signOut(){if(!db)return;setBusy(true);setError("");
    try{const {error:signoutError}=await db.auth.signOut({scope:"local"});if(signoutError)throw signoutError}
    catch(e){setError(errorMessage(e,"Could not sign out."))}finally{setBusy(false)}
  }
  const groups:Record<string,Entry[]>={};
  for(const entry of entries){const month=new Date(entry.photo_date+"T12:00:00").toLocaleDateString("en-US",{month:"long",year:"numeric"});(groups[month]??=[]).push(entry)}

  return <div className="shell">
    <header className="bar"><span className="mark">M</span><strong>Moments <small>shared timeline</small></strong>
      {user&&<button className="signout" disabled={busy} onClick={signOut}>Sign out</button>}
      <span className="pending">{docsState}</span>
    </header>
    {!db?<main className="auth"><h1>Set up the journal</h1><p>Add your Supabase URL and publishable key to the environment before using this site.</p></main>:
    checking?<main className="auth">Opening your journal…</main>:
    !user?<main className="auth"><div className="eyebrow">SHARED PHOTO JOURNAL</div><h1>Sign in to Moments</h1><p>Sign in with your approved Google account to open the shared timeline.</p>
      <button className="primary google-signin" type="button" disabled={busy||!googleReady} onClick={signInGoogle}>Sign in with Google</button>
      {!googleReady&&<p aria-live="polite">{providerChecked?(providerAvailable?"Google sign-in setup is pending.":"Google sign-in is temporarily unavailable."):"Checking Google sign-in…"}</p>}
      <p className="footnote">Only feranmidyro@gmail.com and kieragreen50@gmail.com can access this journal.</p>
      <p className="auth-alternative">Or request an email sign-in link</p>
      <form onSubmit={signIn}><label className="fieldlabel" htmlFor="email">Email address</label><input id="email" className="field" type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/><button className="primary" disabled={busy}>{busy?"Sending…":"Send sign-in link"}</button></form>
      {error&&<div className="notice error" role="alert">{error}</div>}{message&&<div className="notice success" role="status">{message}</div>}</main>:
    !member?<main className="auth"><h1>Access not enabled yet</h1><p>You’re signed in as {user.email}. This journal is available only to its two approved editors.</p><button className="primary" onClick={()=>refresh(db,user)}>Check access</button>{error&&<div className="notice error">{error}</div>}</main>:
    <main className="workspace">
      <aside className="composer"><div className="eyebrow">NEW ENTRY</div><h1>Add a memory</h1><p className="intro">Choose a photo, its date, and a caption. Older photos settle into the right place.</p><form onSubmit={add}>
        <label className="picker">{preview?<img src={preview} alt="Selected photo"/>:<><span className="plus">＋</span><b>Choose a photo</b><span>JPEG, PNG or WebP · up to 10 MB</span></>}
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>setPhoto(e.target.files?.[0]||null)} required/></label>
        {photo&&<div className="selected">{photo.name}<button type="button" onClick={()=>{setPhoto(null);if(input.current)input.current.value=""}}>Remove</button></div>}
        <label className="fieldlabel" htmlFor="date">Date of photo</label><input className="field" id="date" type="date" value={date} onChange={e=>setDate(e.target.value)} required/>
        <label className="fieldlabel" htmlFor="caption">Caption</label><textarea className="field caption" id="caption" placeholder="What happened in this moment?" maxLength={2000} value={caption} onChange={e=>setCaption(e.target.value)} required/>
        <button className="primary" disabled={busy||!photo}>{busy?"Adding…":"Add to timeline"}</button></form>
        <DocsSync key={user.id} db={db} revision={entries.map(entry=>entry.id+entry.photo_date+entry.caption).join("|")} onState={setDocsState}/>
      </aside>
      <section className="feed" aria-label="Photo timeline"><div className="feedhead"><div><div className="eyebrow">PHOTO JOURNAL</div><h2>Our story</h2></div><button className="refresh" disabled={busy||loading} onClick={()=>refresh(db,user)}>Refresh</button><span className="count">{entries.length} {entries.length===1?"memory":"memories"}</span></div>
        {error&&<div className="notice error" role="alert">{error}</div>}{message&&<div className="notice success" role="status">{message}</div>}
        {loading&&entries.length===0?<div className="empty">Loading your timeline…</div>:entries.length===0?<div className="empty"><span>◇</span><h3>Your timeline starts here</h3><p>Add your first photo and caption to begin.</p></div>:
        <div className="timeline">{Object.entries(groups).map(([month,items])=><div className="group" key={month}><h3>{month}</h3>{items.map(entry=><article className="entry" key={entry.id}>
          <div className="date-stamp"><span>{new Date(entry.photo_date+"T12:00:00").toLocaleDateString("en-US",{month:"short"})}</span><b>{entry.photo_date.slice(8)}</b></div>
          {entry.imageUrl?<img src={entry.imageUrl} alt={entry.caption} loading="lazy"/>:<div className="missing-photo" role="status">Photo unavailable. Its date and caption are preserved.</div>}<div className="entrybody">
          {editing?.id===entry.id?<><label className="fieldlabel" htmlFor={"d"+entry.id}>Date</label><input id={"d"+entry.id} className="field" type="date" value={editDate} onChange={e=>setEditDate(e.target.value)}/><label className="fieldlabel" htmlFor={"c"+entry.id}>Caption</label><textarea id={"c"+entry.id} className="field caption" value={editCaption} onChange={e=>setEditCaption(e.target.value)} maxLength={2000}/><div className="actions"><button disabled={busy} onClick={()=>change(entry.id)}>Save</button><button disabled={busy} onClick={()=>setEditing(null)}>Cancel</button></div></>:
          <><p className="entrycaption">{entry.caption}</p><p className="byline">Added by {entry.author_email}</p><div className="actions"><button disabled={busy} onClick={()=>{setEditing(entry);setEditDate(entry.photo_date);setEditCaption(entry.caption)}}>Edit</button><button disabled={busy} onClick={()=>remove(entry)}>Remove</button></div></>}</div>
        </article>)}</div>)}</div>}</section>
    </main>}</div>;
}
