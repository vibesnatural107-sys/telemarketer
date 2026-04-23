import { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Bot, Users, MessageSquare, ShieldCheck, Settings, Info } from 'lucide-react';

export default function App() {
  const [status, setStatus] = useState('Checking...');

  useEffect(() => {
    fetch('/api/health')
      .then(res => res.json())
      .then(data => setStatus(data.status))
      .catch(() => setStatus('Offline'));
  }, []);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-blue-500/30">
      {/* Background Glow */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] bg-blue-600/10 blur-[120px] rounded-full" />
        <div className="absolute -bottom-[10%] -right-[10%] w-[40%] h-[40%] bg-purple-600/10 blur-[120px] rounded-full" />
      </div>

      <main className="relative max-w-6xl mx-auto px-6 py-12">
        {/* Header */}
        <header className="flex items-center justify-between mb-16">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-600/20">
              <Bot className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">TeleMarketerPro <span className="text-blue-500">Bot</span></h1>
          </div>
          <div className="flex items-center gap-2 px-4 py-1.5 bg-zinc-900/50 border border-zinc-800 rounded-full">
            <div className={`w-2 h-2 rounded-full ${status === 'ok' ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">{status === 'ok' ? 'System Online' : 'System Offline'}</span>
          </div>
        </header>

        {/* Hero Section */}
        <section className="mb-20">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="max-w-3xl"
          >
            <h2 className="text-6xl font-extrabold mb-6 leading-[1.1] tracking-tight">
              Scale Your Reach <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500">Without Limits.</span>
            </h2>
            <p className="text-xl text-zinc-400 mb-8 leading-relaxed">
              The ultimate Telegram advertising bot. Manage unlimited accounts, post ads instantly, and grow your audience with professional tools.
            </p>
            <div className="flex flex-wrap gap-4">
              <a 
                href="https://t.me/smartkeysdailyofficial" 
                target="_blank" 
                rel="noopener noreferrer"
                className="px-8 py-4 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-2xl transition-all shadow-xl shadow-blue-600/20 active:scale-95"
              >
                Join Official Channel
              </a>
              <button className="px-8 py-4 bg-zinc-900 hover:bg-zinc-800 text-white font-semibold rounded-2xl transition-all border border-zinc-800 active:scale-95">
                View Documentation
              </button>
            </div>
          </motion.div>
        </section>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-20">
          {[
            { label: 'Total Users', value: '1.2k+', icon: Users, color: 'text-blue-500' },
            { label: 'Ads Posted', value: '45k+', icon: MessageSquare, color: 'text-purple-500' },
            { label: 'Accounts Connected', value: 'Unlimited', icon: ShieldCheck, color: 'text-green-500' },
            { label: 'Response Time', value: '< 100ms', icon: Bot, color: 'text-orange-500' },
          ].map((stat, i) => (
            <motion.div 
              key={i}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: i * 0.1 }}
              className="p-6 bg-zinc-900/30 border border-zinc-800/50 rounded-3xl backdrop-blur-sm"
            >
              <stat.icon className={`w-8 h-8 ${stat.color} mb-4`} />
              <div className="text-2xl font-bold mb-1">{stat.value}</div>
              <div className="text-sm text-zinc-500 font-medium uppercase tracking-wide">{stat.label}</div>
            </motion.div>
          ))}
        </div>

        {/* Features Section */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          <div>
            <h3 className="text-3xl font-bold mb-8">Professional Features</h3>
            <div className="space-y-6">
              {[
                { title: 'Mandatory Join Verification', desc: 'Ensure all users are part of your community before they can access the bot.', icon: ShieldCheck },
                { title: 'Unlimited Account Support', desc: 'No more limits. Add as many Telegram accounts as you need for your campaigns.', icon: Users },
                { title: 'Instant Ad Posting', desc: 'High-speed delivery system ensures your ads reach the target instantly.', icon: MessageSquare },
                { title: 'Zero Lag Interface', desc: 'Optimized for speed. Every button click and command is processed in real-time.', icon: Settings },
              ].map((feature, i) => (
                <div key={i} className="flex gap-4 p-4 hover:bg-zinc-900/50 rounded-2xl transition-colors group">
                  <div className="w-12 h-12 bg-zinc-900 rounded-xl flex items-center justify-center border border-zinc-800 group-hover:border-blue-500/50 transition-colors">
                    <feature.icon className="w-6 h-6 text-blue-500" />
                  </div>
                  <div>
                    <h4 className="font-bold mb-1">{feature.title}</h4>
                    <p className="text-sm text-zinc-500">{feature.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="relative">
            <div className="aspect-square bg-gradient-to-br from-blue-600/20 to-purple-600/20 rounded-[40px] border border-zinc-800 flex items-center justify-center overflow-hidden">
               <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')] opacity-10" />
               <Bot className="w-48 h-48 text-blue-500/50 animate-pulse" />
            </div>
            {/* Floating Badge */}
            <div className="absolute -bottom-6 -left-6 p-6 bg-zinc-900 border border-zinc-800 rounded-3xl shadow-2xl">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-2 h-2 bg-green-500 rounded-full" />
                <span className="text-xs font-bold uppercase tracking-widest text-zinc-400">Verified Bot</span>
              </div>
              <div className="text-xl font-bold">TeleMarketerPro</div>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="mt-32 pt-12 border-t border-zinc-900 flex flex-col md:flex-row justify-between items-center gap-6 text-zinc-500 text-sm">
          <div>© 2026 TeleMarketerPro. All rights reserved.</div>
          <div className="flex gap-8">
            <a href="#" className="hover:text-white transition-colors">Privacy Policy</a>
            <a href="#" className="hover:text-white transition-colors">Terms of Service</a>
            <a href="#" className="hover:text-white transition-colors">Contact Support</a>
          </div>
        </footer>
      </main>
    </div>
  );
}
