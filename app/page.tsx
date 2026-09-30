"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

type Row = { id:string; photo_date:string; caption:string; image_key:string; author_email:string; created_at:string };
type Entry = Row & { imageUrl:string };
const bucket = "photo-journal";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export default function Home(){
  const db = useMemo(() => url && key ? createClient(url,key) : null, []);
  const [user,setUser]=useState<User|null>(null),[checking,setChecking]=useState(true),[member,setMember]=useState(false);
  const [entries,setEntries]=useState<Entry[]>([]),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false);
  const [error,setError]=useState(""),[message,setMessage]=useState(""),[email,setEmail]=useState("");
  const [photo,setPhoto]=useState<File|null>(null),[preview,setPreview]=useState(""),[date,setDate]=useState(""),[caption,setCaption]=useState("");
  const [editing,setEditing]=useState<string|null>(null),[editDate,setEditDate]=useState(""),[editCaption,setEditCaption]=useState("");
  const input=useRef<HTMLInputElement>(null);

  const refresh=useCallback(async (client:SupabaseClient,account:User)=>{
    const {data:access,error:accessError}=await client.from("journal_members").select("email").eq("email",(account.email || "").toLowerCase()).maybeSingle();
    if(accessError){setError(accessError.message);setChecking(false);return}
    if(!access){setMember(false);setEntries([]);setChecking(false);return}
    setMember(true);setChecking(false);setLoading(true);
    try{
      const {data:rows,error:readError}=await client.from("entries").select("id,photo_date,caption,image_key,author_email,created_at").order("photo_date",{ascending:false}).order("created_at",{ascending:true});
      if(readError)throw readError;
      const signed=await Promise.all(((rows || []) as Row[]).map(async row=>{
        const {data:link,error:linkError}=await client.storage.from(bucket).createSignedUrl(row.image_key,3600);
        if(linkError)throw linkError;
        return {...row,imageUrl:link.signedUrl};
      }));
      setEntries(signed);setError("");
    }catch(e){setError(e instanceof Error?e.message:"Could not load entries.")}
    finally{setLoading(false)}
  },[]);
  useEffect(()=>{
    if(!db){setChecking(false);return}
    let active=true;
    db.auth.getUser().then(({data})=>{if(!active)return;setUser(data.user);if(data.user)void refresh(db,data.user);else setChecking(false)}).catch(()=>setChecking(false));
    const {data:listener}=db.auth.onAuthStateChange((_event,session)=>{
      if(!active)return;
      setUser(session?.user || null);
      if(session?.user)setTimeout(()=>{if(active)void refresh(db,session.user)},0);
      else{setEntries([]);setMember(false);setChecking(false)}
    });
    const timer=setInterval(()=>{void db.auth.getUser().then(({data})=>{if(active && data.user)void refresh(db,data.user)})},30000);
    return()=>{active=false;listener.subscription.unsubscribe();clearInterval(timer)};
  },[db,refresh]);
  useEffect(()=>{if(!photo){setPreview("");return}const local=URL.createObjectURL(photo);setPreview(local);return()=>URL.revokeObjectURL(local)},[photo]);
  async function signIn(e:React.FormEvent){e.preventDefault();if(!db||busy)return;setBusy(true);setError("");setMessage("");try{
    const {error:authError}=await db.auth.signInWithOtp({email:email.trim(),options:{emailRedirectTo:window.location.origin,shouldCreateUser:true}});
    if(authError)throw authError;setMessage("Check your email for a sign-in link.");
  }catch(e){setError(e instanceof Error?e.message:"Could not send the sign-in link.")}finally{setBusy(false)}}
  async function add(e:React.FormEvent){e.preventDefault();if(!db||!user||!photo||busy)return;setBusy(true);setError("");setMessage("");
    let imageKey="";
    try{
      if(!["image/jpeg","image/png","image/webp"].includes(photo.type)||photo.size>10_000_000||photo.size===0)throw Error("Choose a JPEG, PNG or WebP photo under 10 MB.");
      const ext=photo.type==="image/png"?"png":photo.type==="image/webp"?"webp":"jpg";
      imageKey=crypto.randomUUID()+"."+ext;
      const {error:uploadError}=await db.storage.from(bucket).upload(imageKey,photo,{contentType:photo.type,upsert:false});
      if(uploadError)throw uploadError;
      const {error:insertError}=await db.from("entries").insert({photo_date:date,caption:caption.trim(),image_key:imageKey,author_email:user.email});
      if(insertError)throw insertError;
      setPhoto(null);setDate("");setCaption("");if(input.current)input.current.value="";
      setMessage("Photo added in date order.");await refresh(db,user);
    }catch(e){if(imageKey)await db.storage.from(bucket).remove([imageKey]);setError(e instanceof Error?e.message:"Could not save photo.")}
    finally{setBusy(false)}
  }
  async function change(id:string){if(!db||!user||busy)return;setBusy(true);setError("");
    try{const {error:saveError}=await db.from("entries").update({photo_date:editDate,caption:editCaption.trim()}).eq("id",id);
      if(saveError)throw saveError;setEditing(null);setMessage("Changes saved.");await refresh(db,user);
    }catch(e){setError(e instanceof Error?e.message:"Could not save changes.")}finally{setBusy(false)}
  }
  async function remove(entry:Entry){if(!db||!user||busy||!confirm("Remove this photo and caption?"))return;setBusy(true);setError("");
    try{const {error:deleteError}=await db.from("entries").delete().eq("id",entry.id);
      if(deleteError)throw deleteError;
      const {error:storageError}=await db.storage.from(bucket).remove([entry.image_key]);
      if(storageError)console.error("Image cleanup failed",storageError);
      setMessage("Entry removed.");await refresh(db,user);
    }catch(e){setError(e instanceof Error?e.message:"Could not remove entry.")}finally{setBusy(false)}
  }
  const groups:Record<string,Entry[]>={};
  for(const entry of entries){const month=new Date(entry.photo_date+"T12:00:00").toLocaleDateString("en-US",{month:"long",year:"numeric"});(groups[month]??=[]).push(entry)}

  return <div className="shell">
    <header className="bar"><span className="mark">M</span><strong>Moments <small>shared timeline</small></strong>
      {user&&<button className="signout" onClick={()=>db?.auth.signOut()}>Sign out</button>}
      <span className="pending">Word connection pending</span>
    </header>
    {!db?<main className="auth"><h1>Set up the journal</h1><p>Add your Supabase URL and publishable key to the environment before using this site.</p></main>:
    checking?<main className="auth">Opening your journal…</main>:
    !user?<main className="auth"><div className="eyebrow">SHARED PHOTO JOURNAL</div><h1>Sign in to Moments</h1><p>Enter your email. We’ll send a link to open the timeline.</p>
      <form onSubmit={signIn}><label className="fieldlabel" htmlFor="email">Email address</label><input id="email" className="field" type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/><button className="primary" disabled={busy}>{busy?"Sending…":"Send sign-in link"}</button></form>
      {error&&<div className="notice error" role="alert">{error}</div>}{message&&<div className="notice success" role="status">{message}</div>}</main>:
    !member?<main className="auth"><h1>Access not enabled yet</h1><p>You’re signed in as {user.email}. Add this address to the journal’s member list in Supabase, then refresh this page.</p><button className="primary" onClick={()=>refresh(db,user)}>Check access</button>{error&&<div className="notice error">{error}</div>}</main>:
    <main className="workspace">
      <aside className="composer"><div className="eyebrow">NEW ENTRY</div><h1>Add a memory</h1><p className="intro">Choose a photo, its date, and a caption. Older photos settle into the right place.</p><form onSubmit={add}>
        <label className="picker">{preview?<img src={preview} alt="Selected photo"/>:<><span className="plus">＋</span><b>Choose a photo</b><span>JPEG, PNG or WebP · up to 10 MB</span></>}
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>setPhoto(e.target.files?.[0]||null)} required/></label>
        {photo&&<div className="selected">{photo.name}<button type="button" onClick={()=>{setPhoto(null);if(input.current)input.current.value=""}}>Remove</button></div>}
        <label className="fieldlabel" htmlFor="date">Date of photo</label><input className="field" id="date" type="date" value={date} onChange={e=>setDate(e.target.value)} required/>
        <label className="fieldlabel" htmlFor="caption">Caption</label><textarea className="field caption" id="caption" placeholder="What happened in this moment?" maxLength={2000} value={caption} onChange={e=>setCaption(e.target.value)} required/>
        <button className="primary" disabled={busy||!photo}>{busy?"Adding…":"Add to timeline"}</button></form>
        <p className="footnote">Entries save here for both editors. Word syncing will be connected after you choose the shared document.</p>
      </aside>
      <section className="feed" aria-label="Photo timeline"><div className="feedhead"><div><div className="eyebrow">PHOTO JOURNAL</div><h2>Our story</h2></div><span className="count">{entries.length} {entries.length===1?"memory":"memories"}</span></div>
        {error&&<div className="notice error" role="alert">{error}</div>}{message&&<div className="notice success" role="status">{message}</div>}
        {loading&&entries.length===0?<div className="empty">Loading your timeline…</div>:entries.length===0?<div className="empty"><span>◇</span><h3>Your timeline starts here</h3><p>Add your first photo and caption to begin.</p></div>:
        <div className="timeline">{Object.entries(groups).map(([month,items])=><div className="group" key={month}><h3>{month}</h3>{items.map(entry=><article className="entry" key={entry.id}>
          <div className="date-stamp"><span>{new Date(entry.photo_date+"T12:00:00").toLocaleDateString("en-US",{month:"short"})}</span><b>{entry.photo_date.slice(8)}</b></div>
          <img src={entry.imageUrl} alt={entry.caption} loading="lazy"/><div className="entrybody">
          {editing===entry.id?<><label className="fieldlabel" htmlFor={"d"+entry.id}>Date</label><input id={"d"+entry.id} className="field" type="date" value={editDate} onChange={e=>setEditDate(e.target.value)}/><label className="fieldlabel" htmlFor={"c"+entry.id}>Caption</label><textarea id={"c"+entry.id} className="field caption" value={editCaption} onChange={e=>setEditCaption(e.target.value)} maxLength={2000}/><div className="actions"><button disabled={busy} onClick={()=>change(entry.id)}>Save</button><button onClick={()=>setEditing(null)}>Cancel</button></div></>:
          <><p className="entrycaption">{entry.caption}</p><p className="byline">Added by {entry.author_email}</p><div className="actions"><button onClick={()=>{setEditing(entry.id);setEditDate(entry.photo_date);setEditCaption(entry.caption)}}>Edit</button><button onClick={()=>remove(entry)}>Remove</button></div></>}</div>
        </article>)}</div>)}</div>}</section>
    </main>}</div>;
}
