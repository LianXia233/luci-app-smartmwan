'use strict';
/*
 * smartmwan 前端共享模块（零 Lua）
 *
 * 放置于 htdocs/luci-static/resources/smartmwan.js，视图用 'require smartmwan' 引入。
 * 只放「每个视图都要用、且必须一致」的东西：
 *   * 信封解析：桥原样透传 {ok, data, error{code,message,details}}，四态判定只此一份；
 *   * 四态渲染：加载中 / 空 / 无权限 / RPC 失败，全部如实，不写「正常」占位；
 *   * 轮询生命周期：poll.add/remove 成对，切页自停（下一 tick 发现容器已不在文档即自行摘除）；
 *   * 展示格式化：毫秒、千分比、字节、时间。
 *
 * 诚实性约束（任务书）：任何「状态」必须来自 RPC 字段或后端 notes，
 * 本文件不提供任何「猜测良好」的辅助函数。
 */
'require poll';
/* 注意：L 与 E 由 LuCI 加载器注入为全局，无需声明；poll/rpc/uci 等模块必须显式
 * require —— 真机实证：漏声明时运行到 `poll.add` 抛 "poll is not defined"。 */

/* 样式表注入：<link> + L.resource，不用内联 <style>；幂等（按 id 判重）。 */
if (document.getElementById('smw-css-link') == null) {
	var link = E('link', {
		'id': 'smw-css-link',
		'rel': 'stylesheet',
		'type': 'text/css',
		'href': L.resource('smartmwan/smartmwan.css')
	});
	document.head.appendChild(link);
}

var smw = L.Class.extend({
	__name__: 'smartmwan',

	/* ---------- 信封 ---------- */

	/**
	 * 解析桥透传的信封。
	 * 返回 { state: 'loading'|'empty'|'error'|'ready', data, error }。
	 * state 的判据只有信封本身，不猜。
	 */
	parse: function(envelope) {
		if (envelope == null)
			return { state: 'error', error: { code: 'io', message: 'RPC 无响应' } };

		if (envelope.ok !== true)
			return {
				state: 'error',
				error: envelope.error || { code: 'unknown', message: '未知错误' }
			};

		var data = envelope.data;

		if (data == null || (Array.isArray(data) && data.length == 0))
			return { state: 'empty', data: data };

		return { state: 'ready', data: data };
	},

	/* ---------- 四态渲染 ---------- */

	/**
	 * 把四态渲染成一个节点。调用方给 ready 状态的渲染器。
	 * loadingText / emptyText 由调用方给具体文案；错误态展示 code + message + details。
	 */
	states: function(parsed, opts) {
		opts = opts || {};

		if (parsed.state == 'loading')
			return E('div', { 'class': 'smw-state smw-state-loading' },
				E('em', { 'class': 'spinning' }, [ opts.loadingText || '加载中…' ]));

		if (parsed.state == 'empty')
			return E('div', { 'class': 'smw-state smw-state-empty' },
				E('em', {}, [ opts.emptyText || '暂无数据' ]));

		if (parsed.state == 'error')
			return E('div', { 'class': 'smw-state smw-state-error alert-message warning' }, [
				E('strong', {}, [ 'RPC 失败：' ]),
				E('span', {}, [ parsed.error.message || String(parsed.error) ]),
				parsed.error.code ? E('div', { 'class': 'smw-error-code' },
					[ '错误码：', E('code', {}, parsed.error.code) ]) : '',
				(parsed.error.details && parsed.error.details.length)
					? E('ul', { 'class': 'smw-error-details' },
						parsed.error.details.map(function(d) { return E('li', {}, [ d ]) }))
					: ''
			]);

		return opts.render(parsed.data);
	},

	/* ---------- 轮询生命周期 ---------- */

	/**
	 * 操作后的局部刷新：重跑 view.load() + view.render()，把新 DOM 替换进文档中的旧根容器。
	 * LuCI 视图没有内建重绘；只调 view.render() 的返回值会被丢弃（没人挂载），
	 * 必须自行替换 DOM。刷新期间按钮的禁用/恢复由 ui.createHandlerFn 自动处理。
	 */
	refresh: function(view, rootId) {
		return Promise.resolve()
			.then(function() { return view.load(); })
			.then(function(data) { return view.render(data); })
			.then(function(newRoot) {
				var old = document.getElementById(rootId);
				if (old != null && old.parentNode != null)
					old.parentNode.replaceChild(newRoot, old);
			})
			.catch(function() { /* 刷新失败不打断操作反馈；下次进入页面会重新加载 */ });
	},

	/**
	 * 注册轮询，保证：
	 *   1. 同一模块同时只有一条活跃轮询（进入先摘旧的）；
	 *   2. 离开页面后自行停止（下一 tick 发现根容器已不在文档即 poll.remove）。
	 * 返回登记用的函数引用（调用方无需关心）。
	 */
	poll: function(rootId, fn, interval) {
		if (this._pollFn != null) {
			poll.remove(this._pollFn);
			this._pollFn = null;
		}

		var self = this;
		var f = function() {
			var root = document.getElementById(rootId);
			if (root == null) {
				// 已被切页替换：成对退出的另一半。
				poll.remove(f);
				if (self._pollFn === f)
					self._pollFn = null;
				return;
			}
			fn();
		};

		this._pollFn = f;
		poll.add(f, interval);
		return f;
	},

	/* ---------- 展示格式化（不造数） ---------- */

	ms: function(v) {
		if (v == null)
			return '—';
		return v >= 1000 ? (v / 1000).toFixed(1) + ' s' : v + ' ms';
	},

	pmm: function(v) {
		if (v == null)
			return '—';
		return (v / 10).toFixed(1) + ' %';
	},

	bytes: function(v) {
		if (v == null)
			return '—';
		var units = [ 'B', 'KiB', 'MiB', 'GiB', 'TiB' ];
		var i = 0;
		while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
		return (i == 0 ? v : v.toFixed(1)) + ' ' + units[i];
	},

	kbps: function(v) {
		if (v == null)
			return '—';
		return v >= 1024 ? (v / 1024).toFixed(1) + ' Mbps' : v + ' kbps';
	},

	time: function(ms) {
		if (ms == null)
			return '—';
		var d = new Date(ms);
		function p(n) { return (n < 10 ? '0' : '') + n; }
		return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
	},

	ago: function(ms, now) {
		if (ms == null)
			return '—';
		var d = (now || Date.now()) - ms;
		if (d < 0)
			d = 0;
		if (d < 60000)
			return Math.floor(d / 1000) + ' 秒前';
		if (d < 3600000)
			return Math.floor(d / 60000) + ' 分钟前';
		return Math.floor(d / 3600000) + ' 小时前';
	},

	/* ---------- 页内 TAB 导航 ---------- */

	/**
	 * 页内 TAB 导航条。
	 * 本固件的 ucode dispatcher 不支持 menu.d 的 tab 字段（官方应用也未使用），
	 * 子页面只会进侧边栏子菜单——页面内的横向 TAB 由这里自绘。
	 * active 取子页面短名（status/lines/balance/failover/games/traffic/config）。
	 */
	tabs: function(active) {
		var pages = [
			[ 'status',   '运行总览' ],
			[ 'lines',    '线路管理' ],
			[ 'balance',  '负载均衡' ],
			[ 'failover', '主备切换' ],
			[ 'games',    '游戏路由' ],
			[ 'traffic',  '连接与流量' ],
			[ 'config',   '配置' ]
		];
		var base = L.url('admin/network/smartmwan');
		return E('ul', { 'class': 'smw-tabs' }, pages.map(function(p) {
			return E('li', { 'class': 'smw-tab' + (p[0] == active ? ' smw-tab-active' : '') },
				[ E('a', { 'href': base + '/' + p[0] }, [ p[1] ]) ]);
		}));
	},

	/** 把 TAB 导航插到页面容器最前面并返回容器。所有视图的 return 都应包一层。 */
	page: function(active, node) {
		node.insertBefore(this.tabs(active), node.firstChild);
		return node;
	},

	/* ---------- 通用零件 ---------- */

	/** 工作模式中文名（balance/failover）。未知值原样返回，不猜。 */
	mode: function(v) {
		return { balance: '均衡', failover: '主备' }[v] || String(v);
	},

	/** 算法中文名（与 src/config/schema.rs::Algorithm 的 UCI 值一一对应）。
	 * 未知值原样返回；技术标识符仍可在括号里保留，便于对配置。 */
	algorithm: function(v) {
		return {
			src_ip: '源地址哈希',
			src_ip_src_port: '源地址+源端口哈希',
			src_ip_dst_ip: '源+目的地址哈希',
			src_ip_dst_ip_dst_port: '源+目的地址+端口哈希',
			full_five_tuple: '完整五元组哈希',
			least_new_connections: '新建连接数最少优先',
			least_traffic: '实时流量最少优先',
			weighted_hash: '加权哈希',
			weighted_ecmp: '内核加权 ECMP'
		}[v] || String(v);
	},

	/** 线路状态徽标：颜色只由 state 决定，不猜。 */
	stateBadge: function(state, label) {
		var cls = {
			healthy: 'smw-badge smw-badge-ok',
			degraded: 'smw-badge smw-badge-warn',
			failed: 'smw-badge smw-badge-bad',
			recovering: 'smw-badge smw-badge-info',
			unknown: 'smw-badge smw-badge-muted'
		}[state] || 'smw-badge smw-badge-muted';
		return E('span', { 'class': cls }, [ label || state ]);
	},

	/** 后端 notes 原样列表：UI 不得只挑好消息。 */
	notes: function(notes) {
		if (!notes || !notes.length)
			return E('span', { 'class': 'smw-muted' }, [ '（无）' ]);
		return E('ul', { 'class': 'smw-notes' },
			notes.map(function(n) { return E('li', {}, [ n ]) }));
	},

	/** 简单表格：head 为字符串数组，rows 为字符串数组的数组。
	 * 注意：行必须用 concat 展平进 children —— LuCI 的 E() 不递归展开嵌套数组，
	 * 嵌套数组会被 String() 化成 "[object HTMLTableRowElement],..."（真机实测）。 */
	table: function(head, rows) {
		var trs = rows.map(function(r) {
			return E('tr', { 'class': 'tr' },
				r.map(function(c) { return E('td', { 'class': 'td' }, [ c ]) }));
		});
		return E('div', { 'class': 'smw-table' },
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' },
					head.map(function(h) { return E('th', { 'class': 'th' }, [ h ]) }))
			].concat(trs)));
	}
});

return smw;
